import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Types } from 'mongoose'

const {
  MockJobsAccountInactiveError,
  mockConnectDB,
  mockIndexes,
  mockFind,
  mockApplicationUpdateOne,
  mockCreateEvent,
  mockCursorFindById,
  mockCursorUpdateOne,
  mockCursorDeleteOne,
  mockActiveJobsAccountIds,
  mockWithActiveJobsAccountWrite,
  mockLoggerInfo,
  mockLoggerWarn,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    MockJobsAccountInactiveError,
    mockConnectDB: vi.fn(),
    mockIndexes: vi.fn(),
    mockFind: vi.fn(),
    mockApplicationUpdateOne: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockCursorFindById: vi.fn(),
    mockCursorUpdateOne: vi.fn(),
    mockCursorDeleteOne: vi.fn(),
    mockActiveJobsAccountIds: vi.fn(),
    mockWithActiveJobsAccountWrite: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
  }
})

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/db/models', () => ({
  JobApplication: {
    collection: { indexes: mockIndexes },
    find: mockFind,
    updateOne: mockApplicationUpdateOne,
  },
  ProductEvent: { create: mockCreateEvent },
}))
vi.mock('../models/TrackerStatusSweepCursor', () => ({
  TrackerStatusSweepCursor: {
    findById: mockCursorFindById,
    updateOne: mockCursorUpdateOne,
    deleteOne: mockCursorDeleteOne,
  },
  JOBS_TRACKER_SWEEP_CURSOR_ID: 'jobs-tracker-status-sweep',
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  activeJobsAccountIds: mockActiveJobsAccountIds,
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
  TRACKER_STATUS_SWEEP_SCAN_LIMIT,
} from '../services/trackerStatusSweepService'

const NOW = new Date('2026-07-21T12:00:00.000Z')
const CUTOFF = new Date('2026-06-16T12:00:00.000Z')
const SESSION = { id: 'transaction-session' }

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    _id: '64b000000000000000000001',
    userId: '64b000000000000000000002',
    jobPostingId: '64b000000000000000000003',
    appliedAt: CUTOFF,
    updatedAt: CUTOFF,
    ...overrides,
  }
}

function mockStoredCursor(value: Record<string, unknown> | null) {
  const lean = vi.fn().mockResolvedValue(value)
  const select = vi.fn(() => ({ lean }))
  mockCursorFindById.mockReturnValue({ select })
  return { select, lean }
}

function mockCandidates(rows: ReturnType<typeof candidate>[]) {
  const lean = vi.fn().mockResolvedValue(rows)
  const hint = vi.fn(() => ({ lean }))
  const limit = vi.fn(() => ({ hint }))
  const sort = vi.fn(() => ({ limit }))
  const select = vi.fn(() => ({ sort }))
  mockFind.mockReturnValue({ select })
  return { select, sort, limit, hint, lean }
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
    mockStoredCursor(null)
    mockApplicationUpdateOne.mockResolvedValue({ modifiedCount: 1 })
    mockCreateEvent.mockResolvedValue([])
    mockCursorUpdateOne.mockResolvedValue({ acknowledged: true })
    mockCursorDeleteOne.mockResolvedValue({ deletedCount: 1 })
    mockActiveJobsAccountIds.mockImplementation(
      async (userIds: string[]) => new Set(userIds),
    )
    mockWithActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(SESSION),
    )
  })

  it('uses a bounded hinted scan for confirmed applications at the cutoff', async () => {
    const row = candidate()
    const cursorQuery = mockStoredCursor(null)
    const query = mockCandidates([row])

    const report = await runTrackerStatusSweep({ now: NOW })

    expect(mockCursorFindById).toHaveBeenCalledWith('jobs-tracker-status-sweep')
    expect(cursorQuery.select).toHaveBeenCalledWith('appliedAt applicationId')
    expect(mockFind).toHaveBeenCalledWith({
      status: 'applied',
      appliedAt: { $type: 'date', $lte: CUTOFF },
    })
    expect(query.select).toHaveBeenCalledWith('_id userId jobPostingId appliedAt updatedAt')
    expect(query.sort).toHaveBeenCalledWith({ appliedAt: 1, _id: 1 })
    expect(query.limit).toHaveBeenCalledWith(TRACKER_STATUS_SWEEP_SCAN_LIMIT)
    expect(query.hint).toHaveBeenCalledWith(TRACKER_STATUS_SWEEP_INDEX_NAME)
    expect(report).toEqual({
      at: NOW.toISOString(),
      cutoff: CUTOFF.toISOString(),
      limit: 500,
      scanLimit: TRACKER_STATUS_SWEEP_SCAN_LIMIT,
      examined: 1,
      scanned: 1,
      ghosted: 1,
      raced: 0,
      prefilterInactive: 0,
      accountInactive: 0,
      capped: false,
      cursorAdvanced: false,
      cursorBlockedByRace: false,
      cursorMalformed: false,
      wrapped: false,
    })
    expect(mockCursorUpdateOne).not.toHaveBeenCalled()
    expect(mockCursorDeleteOne).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledOnce()
  })

  it('fails before cursor or application reads when the exact due-work index is missing', async () => {
    mockIndexes.mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    mockCandidates([candidate()])

    await expect(runTrackerStatusSweep({ now: NOW }))
      .rejects.toThrow(TRACKER_STATUS_SWEEP_INDEX_NAME)

    expect(mockCursorFindById).not.toHaveBeenCalled()
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
  })

  it('uses an exact snapshot CAS and stores system history plus one transactional event', async () => {
    const row = candidate()
    mockCandidates([row])

    await runTrackerStatusSweep({ now: NOW })

    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith(String(row.userId), expect.any(Function))
    expect(mockApplicationUpdateOne).toHaveBeenCalledWith(
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
    expect(mockCreateEvent).toHaveBeenCalledWith([{
      name: 'jobs.ghost_auto',
      userId: row.userId,
      jobPostingId: row.jobPostingId,
      applicationId: row._id,
      props: { count: 1, reason: 'applied-silent-35d' },
      ts: NOW,
    }], { session: SESSION })
  })

  it('does not emit an event when a concurrent write wins the CAS', async () => {
    mockCandidates([candidate()])
    mockApplicationUpdateOne.mockResolvedValue({ modifiedCount: 0 })

    await expect(runTrackerStatusSweep({ now: NOW })).resolves.toMatchObject({
      ghosted: 0,
      raced: 1,
      cursorBlockedByRace: true,
    })
    expect(mockCreateEvent).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('is idempotent when a retry replays the same candidate snapshot', async () => {
    mockCandidates([candidate()])
    mockApplicationUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })

    const first = await runTrackerStatusSweep({ now: NOW })
    const retry = await runTrackerStatusSweep({ now: NOW })

    expect(first.ghosted).toBe(1)
    expect(retry).toMatchObject({ ghosted: 0, raced: 1 })
    expect(mockCreateEvent).toHaveBeenCalledOnce()
  })

  it('fences an account that becomes inactive after prefiltering and continues', async () => {
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
      examined: 2,
      scanned: 2,
      ghosted: 1,
      prefilterInactive: 0,
      accountInactive: 1,
    })
    expect(mockApplicationUpdateOne).toHaveBeenCalledOnce()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('bounds an inactive raw page and checkpoints past it for the next run', async () => {
    const first = candidate({
      _id: '64b000000000000000000004',
      userId: '64b000000000000000000010',
    })
    const second = candidate({
      _id: '64b000000000000000000005',
      userId: '64b000000000000000000011',
    })
    mockCandidates([first, second])
    mockActiveJobsAccountIds.mockResolvedValue(new Set())

    const report = await runTrackerStatusSweep({ now: NOW, limit: 1, scanLimit: 2 })

    expect(report).toMatchObject({
      scanLimit: 2,
      examined: 2,
      scanned: 0,
      ghosted: 0,
      prefilterInactive: 2,
      capped: true,
      cursorAdvanced: true,
      wrapped: false,
    })
    expect(mockApplicationUpdateOne).not.toHaveBeenCalled()
    expect(mockCursorUpdateOne).toHaveBeenCalledWith(
      { _id: 'jobs-tracker-status-sweep' },
      {
        $set: {
          appliedAt: second.appliedAt,
          applicationId: second._id,
          lastRunAt: NOW,
        },
      },
      { upsert: true },
    )
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('discards a malformed cursor and restarts with a bounded scan', async () => {
    // A hex-looking BSON string is still unsafe for tuple comparison against
    // ObjectId application keys and must not be accepted as a valid cursor.
    mockStoredCursor({
      appliedAt: CUTOFF,
      applicationId: '64b000000000000000000005',
    })
    mockCandidates([])

    const report = await runTrackerStatusSweep({ now: NOW, scanLimit: 2 })

    expect(mockFind).toHaveBeenCalledWith({
      status: 'applied',
      appliedAt: { $type: 'date', $lte: CUTOFF },
    })
    expect(report).toMatchObject({
      examined: 0,
      cursorMalformed: true,
      cursorAdvanced: false,
      wrapped: true,
    })
    expect(mockCursorDeleteOne).toHaveBeenCalledWith({
      _id: 'jobs-tracker-status-sweep',
    })
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it('resumes after the durable cursor, reaches active work, and wraps on exhaustion', async () => {
    const stored = {
      appliedAt: CUTOFF,
      applicationId: new Types.ObjectId('64b000000000000000000005'),
    }
    const active = candidate({
      _id: '64b000000000000000000006',
      userId: '64b000000000000000000012',
      jobPostingId: '64b000000000000000000013',
    })
    mockStoredCursor(stored)
    mockCandidates([active])

    const report = await runTrackerStatusSweep({ now: NOW, limit: 1, scanLimit: 2 })

    expect(mockFind).toHaveBeenCalledWith({
      status: 'applied',
      appliedAt: { $type: 'date', $lte: CUTOFF },
      $or: [
        { appliedAt: { $gt: stored.appliedAt } },
        { appliedAt: stored.appliedAt, _id: { $gt: stored.applicationId } },
      ],
    })
    expect(report).toMatchObject({
      examined: 1,
      scanned: 1,
      ghosted: 1,
      capped: false,
      cursorAdvanced: false,
      wrapped: true,
    })
    expect(mockCursorDeleteOne).toHaveBeenCalledWith({
      _id: 'jobs-tracker-status-sweep',
    })
  })

  it('never checkpoints past an active row deferred by the write cap', async () => {
    const firstActive = candidate({
      _id: '64b000000000000000000004',
      userId: '64b000000000000000000010',
    })
    const inactive = candidate({
      _id: '64b000000000000000000005',
      userId: '64b000000000000000000011',
    })
    const deferredActive = candidate({
      _id: '64b000000000000000000006',
      userId: '64b000000000000000000012',
    })
    mockCandidates([firstActive, inactive, deferredActive])
    mockActiveJobsAccountIds.mockResolvedValue(new Set([
      String(firstActive.userId),
      String(deferredActive.userId),
    ]))

    const report = await runTrackerStatusSweep({ now: NOW, limit: 1, scanLimit: 3 })

    expect(report).toMatchObject({
      examined: 3,
      scanned: 1,
      ghosted: 1,
      capped: true,
      cursorAdvanced: true,
    })
    expect(mockApplicationUpdateOne).toHaveBeenCalledOnce()
    expect(mockCursorUpdateOne).toHaveBeenCalledWith(
      { _id: 'jobs-tracker-status-sweep' },
      {
        $set: {
          appliedAt: inactive.appliedAt,
          applicationId: inactive._id,
          lastRunAt: NOW,
        },
      },
      { upsert: true },
    )
  })

  it('checkpoints before a CAS loser and retries that row on the next run', async () => {
    const first = candidate({
      _id: '64b000000000000000000004',
      jobPostingId: '64b000000000000000000014',
    })
    const raced = candidate({
      _id: '64b000000000000000000005',
      jobPostingId: '64b000000000000000000015',
    })
    const query = mockCandidates([first, raced])
    query.lean
      .mockResolvedValueOnce([first, raced])
      .mockResolvedValueOnce([raced])
    mockApplicationUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 })

    const firstRun = await runTrackerStatusSweep({ now: NOW, limit: 2, scanLimit: 2 })

    expect(firstRun).toMatchObject({
      ghosted: 1,
      raced: 1,
      cursorAdvanced: true,
      cursorBlockedByRace: true,
      wrapped: false,
    })
    expect(mockCursorUpdateOne).toHaveBeenCalledWith(
      { _id: 'jobs-tracker-status-sweep' },
      {
        $set: {
          appliedAt: first.appliedAt,
          applicationId: first._id,
          lastRunAt: NOW,
        },
      },
      { upsert: true },
    )

    const storedApplicationId = new Types.ObjectId(first._id)
    mockStoredCursor({ appliedAt: first.appliedAt, applicationId: storedApplicationId })
    const retry = await runTrackerStatusSweep({ now: NOW, limit: 2, scanLimit: 2 })

    expect(mockFind).toHaveBeenLastCalledWith({
      status: 'applied',
      appliedAt: { $type: 'date', $lte: CUTOFF },
      $or: [
        { appliedAt: { $gt: first.appliedAt } },
        { appliedAt: first.appliedAt, _id: { $gt: storedApplicationId } },
      ],
    })
    expect(retry).toMatchObject({
      scanned: 1,
      ghosted: 1,
      raced: 0,
      cursorBlockedByRace: false,
      wrapped: true,
    })
  })

  it('keeps an existing cursor when the first resumed row loses the CAS', async () => {
    const stored = {
      appliedAt: CUTOFF,
      applicationId: new Types.ObjectId('64b000000000000000000004'),
    }
    const raced = candidate({
      _id: '64b000000000000000000005',
      jobPostingId: '64b000000000000000000015',
    })
    mockStoredCursor(stored)
    mockCandidates([raced])
    mockApplicationUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 })

    const firstRun = await runTrackerStatusSweep({ now: NOW, scanLimit: 2 })

    expect(firstRun).toMatchObject({
      raced: 1,
      cursorAdvanced: false,
      cursorBlockedByRace: true,
      wrapped: false,
    })
    expect(mockCursorUpdateOne).not.toHaveBeenCalled()
    expect(mockCursorDeleteOne).not.toHaveBeenCalled()

    const retry = await runTrackerStatusSweep({ now: NOW, scanLimit: 2 })

    expect(mockFind).toHaveBeenLastCalledWith({
      status: 'applied',
      appliedAt: { $type: 'date', $lte: CUTOFF },
      $or: [
        { appliedAt: { $gt: stored.appliedAt } },
        { appliedAt: stored.appliedAt, _id: { $gt: stored.applicationId } },
      ],
    })
    expect(retry).toMatchObject({
      ghosted: 1,
      raced: 0,
      wrapped: true,
    })
    expect(mockCursorDeleteOne).toHaveBeenCalledOnce()
  })

  it('fails on cursor upsert loss and replays without duplicating its event', async () => {
    const row = candidate()
    const query = mockCandidates([row])
    query.lean
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
    mockCursorUpdateOne.mockRejectedValueOnce(new Error('cursor upsert unavailable'))
    mockApplicationUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 })

    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 1 }))
      .rejects.toThrow('cursor upsert unavailable')

    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 1 }))
      .resolves.toMatchObject({ raced: 1, cursorBlockedByRace: true })
    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 1 }))
      .resolves.toMatchObject({ examined: 0, cursorBlockedByRace: false })
    expect(mockCreateEvent).toHaveBeenCalledOnce()
  })

  it('fails on cursor delete loss and safely finishes deletion on retry', async () => {
    const stored = {
      appliedAt: CUTOFF,
      applicationId: new Types.ObjectId('64b000000000000000000004'),
    }
    const row = candidate({ _id: '64b000000000000000000005' })
    const query = mockCandidates([row])
    query.lean
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
    mockStoredCursor(stored)
    mockCursorDeleteOne
      .mockRejectedValueOnce(new Error('cursor delete unavailable'))
      .mockResolvedValueOnce({ deletedCount: 1 })

    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 2 }))
      .rejects.toThrow('cursor delete unavailable')

    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 2 }))
      .resolves.toMatchObject({ examined: 0, wrapped: true })
    expect(mockCreateEvent).toHaveBeenCalledOnce()
    expect(mockCursorDeleteOne).toHaveBeenCalledTimes(2)
  })

  it('propagates transaction failures without advancing the cursor', async () => {
    mockCandidates([candidate(), candidate({ _id: '64b000000000000000000004' })])
    mockWithActiveJobsAccountWrite.mockRejectedValue(new Error('transactions unavailable'))

    await expect(runTrackerStatusSweep({ now: NOW, scanLimit: 2 }))
      .rejects.toThrow('transactions unavailable')
    expect(mockCursorUpdateOne).not.toHaveBeenCalled()
    expect(mockCursorDeleteOne).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })
})
