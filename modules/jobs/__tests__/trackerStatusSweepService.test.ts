import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockJobsAccountInactiveError,
  mockConnectDB,
  mockIndexes,
  mockAggregate,
  mockAggregateHint,
  mockUpdateOne,
  mockCreateEvent,
  mockWithActiveJobsAccountWrite,
  mockLoggerInfo,
  mockLoggerWarn,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    MockJobsAccountInactiveError,
    mockConnectDB: vi.fn(),
    mockIndexes: vi.fn(),
    mockAggregate: vi.fn(),
    mockAggregateHint: vi.fn(),
    mockUpdateOne: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockWithActiveJobsAccountWrite: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
  }
})

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobApplication: {
    collection: { indexes: mockIndexes },
    aggregate: mockAggregate,
    updateOne: mockUpdateOne,
  },
  ProductEvent: { create: mockCreateEvent },
  User: { collection: { name: 'users' } },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JOBS_ACTIVE_ACCOUNT_STATES_FILTER: {
    $or: [
      { accountState: 'active' },
      { accountState: { $exists: false } },
    ],
  },
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))
vi.mock('@shared/logger', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn },
}))

import {
  runTrackerStatusSweep,
  TRACKER_STATUS_SWEEP_INDEX_KEY,
  TRACKER_STATUS_SWEEP_INDEX_NAME,
  TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
} from '../services/trackerStatusSweepService'

const NOW = new Date('2026-07-21T12:00:00.000Z')
const SESSION = { id: 'transaction-session' }

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    _id: '64b000000000000000000001',
    userId: '64b000000000000000000002',
    jobPostingId: '64b000000000000000000003',
    appliedAt: new Date('2026-06-16T12:00:00.000Z'),
    updatedAt: new Date('2026-06-16T12:00:00.000Z'),
    ...overrides,
  }
}

function mockCandidates(rows: ReturnType<typeof candidate>[]) {
  mockAggregateHint.mockResolvedValue(rows)
}

describe('runTrackerStatusSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnectDB.mockResolvedValue(undefined)
    mockIndexes.mockResolvedValue([{
      name: TRACKER_STATUS_SWEEP_INDEX_NAME,
      key: TRACKER_STATUS_SWEEP_INDEX_KEY,
      partialFilterExpression: TRACKER_STATUS_SWEEP_INDEX_PARTIAL,
    }])
    mockAggregate.mockReturnValue({ hint: mockAggregateHint })
    mockAggregateHint.mockResolvedValue([])
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
    mockCreateEvent.mockResolvedValue([])
    mockWithActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(SESSION),
    )
  })

  it('selects only explicitly confirmed applications at the 35-day cutoff', async () => {
    const row = candidate()
    mockCandidates([row])

    const report = await runTrackerStatusSweep({ now: NOW })

    const cutoff = new Date('2026-06-16T12:00:00.000Z')
    expect(mockAggregate).toHaveBeenCalledWith([
      {
        $match: {
          status: 'applied',
          appliedAt: { $type: 'date', $lte: cutoff },
        },
      },
      { $sort: { appliedAt: 1, _id: 1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            {
              $match: {
                $or: [
                  { accountState: 'active' },
                  { accountState: { $exists: false } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'activeOwner',
        },
      },
      { $match: { 'activeOwner.0': { $exists: true } } },
      { $limit: 501 },
      {
        $project: {
          _id: 1,
          userId: 1,
          jobPostingId: 1,
          appliedAt: 1,
          updatedAt: 1,
        },
      },
    ])
    expect(mockAggregateHint).toHaveBeenCalledWith(TRACKER_STATUS_SWEEP_INDEX_NAME)
    expect(report).toEqual({
      at: NOW.toISOString(),
      cutoff: cutoff.toISOString(),
      limit: 500,
      scanned: 1,
      ghosted: 1,
      raced: 0,
      accountInactive: 0,
      capped: false,
    })
  })

  it('fails before scanning when the exact due-work index is missing', async () => {
    mockIndexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    mockCandidates([candidate()])

    await expect(runTrackerStatusSweep({ now: NOW }))
      .rejects.toThrow(TRACKER_STATUS_SWEEP_INDEX_NAME)

    expect(mockAggregate).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
  })

  it('uses an exact snapshot CAS and stores system history plus one transactional event', async () => {
    const row = candidate()
    mockCandidates([row])

    await runTrackerStatusSweep({ now: NOW })

    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith(String(row.userId), expect.any(Function))
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: row._id,
        userId: row.userId,
        jobPostingId: row.jobPostingId,
        status: 'applied',
        appliedAt: row.appliedAt,
        updatedAt: row.updatedAt,
      },
      {
        $set: { status: 'ghosted', ghostSuggestedAt: NOW },
        $push: { statusHistory: { status: 'ghosted', at: NOW, source: 'system' } },
      },
      { session: SESSION },
    )
    expect(mockCreateEvent).toHaveBeenCalledWith([
      {
        name: 'jobs.ghost_auto',
        userId: row.userId,
        jobPostingId: row.jobPostingId,
        applicationId: row._id,
        props: { count: 1, reason: 'applied-silent-35d' },
        ts: NOW,
      },
    ], { session: SESSION })
  })

  it('does not emit an event when a concurrent write wins the CAS', async () => {
    mockCandidates([candidate()])
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })

    await expect(runTrackerStatusSweep({ now: NOW })).resolves.toMatchObject({
      ghosted: 0,
      raced: 1,
    })
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('is idempotent when a retry replays the same candidate snapshot', async () => {
    const row = candidate()
    mockCandidates([row])
    mockUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })

    const first = await runTrackerStatusSweep({ now: NOW })
    const retry = await runTrackerStatusSweep({ now: NOW })

    expect(first.ghosted).toBe(1)
    expect(retry).toMatchObject({ ghosted: 0, raced: 1 })
    expect(mockCreateEvent).toHaveBeenCalledOnce()
  })

  it('fences an account that becomes inactive after selection and continues', async () => {
    const inactive = candidate()
    const active = candidate({
      _id: '64b000000000000000000004',
      userId: '64b000000000000000000005',
      jobPostingId: '64b000000000000000000006',
    })
    mockCandidates([inactive, active])
    mockWithActiveJobsAccountWrite
      .mockRejectedValueOnce(new MockJobsAccountInactiveError())
      .mockImplementationOnce(
        async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(SESSION),
      )

    await expect(runTrackerStatusSweep({ now: NOW })).resolves.toMatchObject({
      scanned: 2,
      ghosted: 1,
      accountInactive: 1,
    })
    expect(mockUpdateOne).toHaveBeenCalledOnce()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('does no transactional work when owner filtering removes every due row', async () => {
    mockCandidates([])

    const report = await runTrackerStatusSweep({ now: NOW, limit: 1 })

    expect(report).toMatchObject({
      scanned: 0,
      ghosted: 0,
      accountInactive: 0,
      capped: false,
    })
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('processes only the bounded window and reports deferred work', async () => {
    mockCandidates([
      candidate(),
      candidate({ _id: '64b000000000000000000004' }),
      candidate({ _id: '64b000000000000000000005' }),
    ])

    const report = await runTrackerStatusSweep({ now: NOW, limit: 2 })

    expect(report).toMatchObject({ limit: 2, scanned: 2, ghosted: 2, capped: true })
    expect(mockUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('propagates transaction failures other than inactive accounts', async () => {
    mockCandidates([candidate()])
    mockWithActiveJobsAccountWrite.mockRejectedValue(new Error('transactions unavailable'))

    await expect(runTrackerStatusSweep({ now: NOW })).rejects.toThrow('transactions unavailable')
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })
})
