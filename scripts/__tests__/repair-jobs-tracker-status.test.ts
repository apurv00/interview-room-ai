import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  countDocuments: vi.fn(),
  find: vi.fn(),
  bulkWrite: vi.fn(),
  withActiveJobsAccountWrite: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  JobApplication: {
    countDocuments: mocks.countDocuments,
    find: mocks.find,
    bulkWrite: mocks.bulkWrite,
  },
}))
vi.mock('../../shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {},
  withActiveJobsAccountWrite: mocks.withActiveJobsAccountWrite,
}))

import {
  assertTrackerStatusInvariant,
  invalidUnconfirmedGhostFilter,
  runTrackerStatusRepair,
  trackerStatusRepairModeOf,
} from '../repair-jobs-tracker-status'

function findPage(rows: unknown[]) {
  return {
    select: () => ({
      sort: () => ({
        limit: () => ({ lean: () => Promise.resolve(rows) }),
      }),
    }),
  }
}

describe('Jobs tracker-status repair deploy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    mocks.bulkWrite.mockResolvedValue({ modifiedCount: 1 })
    mocks.withActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work({ id: 'session' }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    [[], 'dry-run'],
    [['--apply'], 'apply'],
    [['--check'], 'check'],
  ] as const)('parses %j as %s mode', (argv, expected) => {
    expect(trackerStatusRepairModeOf([...argv])).toBe(expected)
  })

  it('rejects ambiguous and unknown modes', () => {
    expect(() => trackerStatusRepairModeOf(['--apply', '--check'])).toThrow(/either --apply or --check/)
    expect(() => trackerStatusRepairModeOf(['--aply'])).toThrow('unknown argument: --aply')
  })

  it('treats missing, null, or malformed appliedAt as unconfirmed via BSON type', () => {
    expect(invalidUnconfirmedGhostFilter()).toEqual({
      status: 'ghosted',
      appliedAt: { $not: { $type: 'date' } },
      $expr: { $and: [
        { $eq: [{ $arrayElemAt: ['$statusHistory.status', -1] }, 'ghosted'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.source', -1] }, 'system'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.status', -2] }, 'apply_clicked'] },
        { $eq: [{ $arrayElemAt: ['$statusHistory.source', -2] }, 'system'] },
      ] },
    })
  })

  it('keeps check mode physically read-only and fails on contradictions', async () => {
    mocks.countDocuments.mockResolvedValueOnce(2)

    await expect(runTrackerStatusRepair(['--check'])).rejects.toThrow('unconfirmed system-ghosted rows=2')
    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.bulkWrite).not.toHaveBeenCalled()
  })

  it('repairs only exact snapshots inside the account fence and appends a correction audit entry', async () => {
    const updatedAt = new Date('2026-07-01T00:00:00.000Z')
    const at = new Date('2026-07-21T12:00:00.000Z')
    const row = { _id: 'app-1', userId: 'user-1', updatedAt }
    mocks.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    mocks.find.mockReturnValueOnce(findPage([row])).mockReturnValueOnce(findPage([]))

    await expect(runTrackerStatusRepair(['--apply'], at)).resolves.toBeUndefined()

    expect(mocks.withActiveJobsAccountWrite).toHaveBeenCalledWith('user-1', expect.any(Function))
    const [operations, options] = mocks.bulkWrite.mock.calls[0]
    expect(options).toEqual({ session: { id: 'session' } })
    expect(operations[0].updateOne.filter).toMatchObject({
      _id: 'app-1', userId: 'user-1', updatedAt, status: 'ghosted', appliedAt: { $not: { $type: 'date' } },
    })
    expect(operations[0].updateOne.update).toEqual({
      $set: { status: 'apply_clicked' },
      $unset: { ghostSuggestedAt: 1 },
      $push: { statusHistory: { status: 'apply_clicked', at, source: 'system' } },
    })
  })

  it('passes only when no historical contradiction remains', () => {
    expect(() => assertTrackerStatusInvariant(0)).not.toThrow()
    expect(() => assertTrackerStatusInvariant(1)).toThrow('unconfirmed system-ghosted rows=1')
  })
})
