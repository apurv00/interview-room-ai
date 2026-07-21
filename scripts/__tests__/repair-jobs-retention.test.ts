import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  distinct: vi.fn(),
  countDocuments: vi.fn(),
  updateMany: vi.fn(),
}))

vi.mock('../../shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('../../shared/db/models', () => ({
  JobApplication: { distinct: mocks.distinct },
  JobPosting: {
    countDocuments: mocks.countDocuments,
    updateMany: mocks.updateMany,
  },
}))

import {
  assertRetentionInvariant,
  retentionRepairModeOf,
  runRetentionRepair,
} from '../repair-jobs-retention'

describe('Jobs retention repair deploy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connectDB.mockResolvedValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [[], 'dry-run'],
    [['--apply'], 'apply'],
    [['--check'], 'check'],
  ] as const)('parses %j as %s mode', (argv, mode) => {
    expect(retentionRepairModeOf([...argv])).toBe(mode)
  })

  it('rejects an ambiguous mutating check invocation', () => {
    expect(() => retentionRepairModeOf(['--apply', '--check'])).toThrow(/either --apply or --check/)
  })

  it('rejects unknown arguments instead of silently falling back to a dry run', () => {
    expect(() => retentionRepairModeOf(['--aply'])).toThrow('unknown argument: --aply')
  })

  it('passes only when every retained owner row is pinned without a TTL', () => {
    expect(() => assertRetentionInvariant({ ownerContradictions: 0, pinnedWithTtl: 0 })).not.toThrow()
  })

  it.each([
    [{ ownerContradictions: 2, pinnedWithTtl: 0 }, 'owner contradictions=2'],
    [{ ownerContradictions: 0, pinnedWithTtl: 3 }, 'pinned TTL rows=3'],
    [{ ownerContradictions: 2, pinnedWithTtl: 3 }, 'owner contradictions=2, pinned TTL rows=3'],
  ])('fails promotion for invariant drift %j', (counts, message) => {
    expect(() => assertRetentionInvariant(counts)).toThrow(message)
  })

  it('keeps --check read-only and rejects owner-retention drift', async () => {
    mocks.distinct.mockResolvedValue(['owned-1'])
    mocks.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)

    await expect(runRetentionRepair(['--check'])).rejects.toThrow('owner contradictions=1')

    expect(mocks.connectDB).toHaveBeenCalledWith({ schemaInitialization: 'disabled' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('passes --check without writes when no contradictions remain', async () => {
    mocks.distinct.mockResolvedValue(['owned-1'])
    mocks.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)

    await expect(runRetentionRepair(['--check'])).resolves.toBeUndefined()

    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('re-reads owner ids before verifying an applied repair', async () => {
    mocks.distinct
      .mockResolvedValueOnce(['owned-1'])
      .mockResolvedValueOnce(['owned-1', 'owned-2'])
    mocks.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    mocks.updateMany
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 1 })

    await expect(runRetentionRepair(['--apply'])).resolves.toBeUndefined()

    expect(mocks.distinct).toHaveBeenCalledTimes(2)
    expect(mocks.countDocuments).toHaveBeenNthCalledWith(4, {
      _id: { $in: ['owned-1', 'owned-2'] },
      $or: [
        { userReferenced: { $ne: true } },
        { purgeAt: { $exists: true } },
      ],
    })
  })
})
