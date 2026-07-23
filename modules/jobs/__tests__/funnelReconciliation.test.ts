import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockApplicationAggregate,
  mockEventAggregate,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockApplicationAggregate: vi.fn(),
  mockEventAggregate: vi.fn(),
  mockLoggerError: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  JobApplication: { aggregate: (...args: unknown[]) => mockApplicationAggregate(...args) },
  ProductEvent: { aggregate: (...args: unknown[]) => mockEventAggregate(...args) },
}))
vi.mock('@shared/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

import { reconcileJobsFunnelTelemetry } from '../services/funnelReconciliation'

const NOW = new Date('2026-07-23T12:00:00.000Z')
const WINDOW_END = new Date('2026-07-23T11:55:00.000Z')
const WINDOW_START = new Date('2026-07-22T11:55:00.000Z')

function transitionRow(userId: string, jobPostingId: string, ts: Date, count = 1) {
  return { _id: { userId, jobPostingId, ts }, count }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Jobs funnel telemetry reconciliation', () => {
  it('uses one settled window for durable transitions and server-owned events', async () => {
    mockApplicationAggregate.mockResolvedValue([
      transitionRow('user-1', 'job-1', new Date('2026-07-23T10:00:00.000Z')),
    ])
    mockEventAggregate.mockResolvedValue([
      transitionRow('user-1', 'job-1', new Date('2026-07-23T10:00:00.000Z')),
    ])

    const report = await reconcileJobsFunnelTelemetry(NOW)

    expect(report).toMatchObject({
      status: 'ready',
      windowStart: WINDOW_START.toISOString(),
      windowEnd: WINDOW_END.toISOString(),
      settlingDelayMinutes: 5,
      mismatchCount: 0,
      eventName: 'jobs.apply_confirmed',
      factCount: 1,
      eventCount: 1,
      missingEvents: 0,
      extraEvents: 0,
    })
    expect(mockApplicationAggregate).toHaveBeenCalledWith([
      {
        $match: {
          statusHistory: {
            $elemMatch: {
              source: 'user',
              status: 'applied',
              at: { $gte: WINDOW_START, $lte: WINDOW_END },
            },
          },
        },
      },
      { $unwind: '$statusHistory' },
      {
        $match: {
          'statusHistory.source': 'user',
          'statusHistory.status': 'applied',
          'statusHistory.at': { $gte: WINDOW_START, $lte: WINDOW_END },
        },
      },
      {
        $group: {
          _id: {
            userId: '$userId',
            jobPostingId: '$jobPostingId',
            ts: '$statusHistory.at',
          },
          count: { $sum: 1 },
        },
      },
    ])
    expect(mockEventAggregate).toHaveBeenCalledWith([
      {
        $match: {
          name: 'jobs.apply_confirmed',
          ts: { $gte: WINDOW_START, $lte: WINDOW_END },
        },
      },
      {
        $group: {
          _id: {
            userId: '$userId',
            jobPostingId: '$jobPostingId',
            ts: '$ts',
          },
          count: { $sum: 1 },
        },
      },
    ])
  })

  it('does not let equal global totals cancel per-transition drift', async () => {
    mockApplicationAggregate.mockResolvedValue([
      transitionRow('user-1', 'job-1', new Date('2026-07-23T09:00:00.000Z')),
      transitionRow('user-2', 'job-2', new Date('2026-07-23T09:30:00.000Z')),
    ])
    mockEventAggregate.mockResolvedValue([
      transitionRow('user-1', 'job-1', new Date('2026-07-23T09:00:00.000Z')),
      transitionRow('user-3', 'job-3', new Date('2026-07-23T10:30:00.000Z')),
    ])

    const report = await reconcileJobsFunnelTelemetry(NOW)

    expect(report.status).toBe('warning')
    expect(report.mismatchCount).toBe(2)
    expect(report).toMatchObject({
      eventName: 'jobs.apply_confirmed',
      factCount: 2,
      eventCount: 2,
      missingEvents: 1,
      extraEvents: 1,
    })
  })

  it('keeps source controls readable when reconciliation queries fail', async () => {
    const error = new Error('aggregate unavailable')
    mockApplicationAggregate.mockRejectedValue(error)
    mockEventAggregate.mockResolvedValue([])

    const report = await reconcileJobsFunnelTelemetry(NOW)

    expect(report).toMatchObject({
      status: 'unavailable',
      mismatchCount: null,
      factCount: null,
      eventCount: null,
      missingEvents: null,
      extraEvents: null,
    })
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error },
      'jobs funnel telemetry reconciliation unavailable',
    )
  })
})
