import { JobApplication, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'

const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000
const EVENT_SETTLING_DELAY_MS = 5 * 60 * 1000
const APPLY_CONFIRMED_EVENT = 'jobs.apply_confirmed' as const

interface TransitionCountRow {
  _id: {
    userId: unknown
    jobPostingId: unknown
    ts: unknown
  }
  count: number
}

export interface JobsFunnelReconciliation {
  status: 'ready' | 'warning' | 'unavailable'
  eventName: typeof APPLY_CONFIRMED_EVENT
  windowStart: string
  windowEnd: string
  settlingDelayMinutes: number
  mismatchCount: number | null
  factCount: number | null
  eventCount: number | null
  missingEvents: number | null
  extraEvents: number | null
}

function transitionKey(row: TransitionCountRow): string {
  const ts = new Date(row._id.ts as string | number | Date)
  return [
    String(row._id.userId ?? ''),
    String(row._id.jobPostingId ?? ''),
    Number.isNaN(ts.getTime()) ? String(row._id.ts ?? '') : ts.toISOString(),
  ].join('\0')
}

function transitionCounts(rows: TransitionCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [transitionKey(row), row.count]))
}

/**
 * Compares server-owned lifecycle telemetry with the durable application
 * transitions that should have emitted it. The newest five minutes are
 * excluded so an in-flight post-commit telemetry write cannot raise a false
 * alert while the CMS request is reading both collections.
 */
export async function reconcileJobsFunnelTelemetry(
  now = new Date(),
): Promise<JobsFunnelReconciliation> {
  const windowEnd = new Date(now.getTime() - EVENT_SETTLING_DELAY_MS)
  const windowStart = new Date(windowEnd.getTime() - RECONCILIATION_WINDOW_MS)

  try {
    const [factRows, eventRows] = await Promise.all([
      JobApplication.aggregate<TransitionCountRow>([
        {
          $match: {
            statusHistory: {
              $elemMatch: {
                source: 'user',
                status: 'applied',
                at: { $gte: windowStart, $lte: windowEnd },
              },
            },
          },
        },
        { $unwind: '$statusHistory' },
        {
          $match: {
            'statusHistory.source': 'user',
            'statusHistory.status': 'applied',
            'statusHistory.at': { $gte: windowStart, $lte: windowEnd },
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
      ]),
      ProductEvent.aggregate<TransitionCountRow>([
        {
          $match: {
            name: APPLY_CONFIRMED_EVENT,
            ts: { $gte: windowStart, $lte: windowEnd },
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
      ]),
    ])

    const facts = transitionCounts(factRows)
    const events = transitionCounts(eventRows)
    const keys = new Set([
      ...Array.from(facts.keys()),
      ...Array.from(events.keys()),
    ])
    let factCount = 0
    let eventCount = 0
    let missingEvents = 0
    let extraEvents = 0
    for (const key of Array.from(keys)) {
      const factsForKey = facts.get(key) ?? 0
      const eventsForKey = events.get(key) ?? 0
      factCount += factsForKey
      eventCount += eventsForKey
      missingEvents += Math.max(0, factsForKey - eventsForKey)
      extraEvents += Math.max(0, eventsForKey - factsForKey)
    }
    const mismatchCount = missingEvents + extraEvents
    return {
      status: mismatchCount ? 'warning' : 'ready',
      eventName: APPLY_CONFIRMED_EVENT,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      settlingDelayMinutes: EVENT_SETTLING_DELAY_MS / 60_000,
      mismatchCount,
      factCount,
      eventCount,
      missingEvents,
      extraEvents,
    }
  } catch (error) {
    logger.error({ error }, 'jobs funnel telemetry reconciliation unavailable')
    return {
      status: 'unavailable',
      eventName: APPLY_CONFIRMED_EVENT,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      settlingDelayMinutes: EVENT_SETTLING_DELAY_MS / 60_000,
      mismatchCount: null,
      factCount: null,
      eventCount: null,
      missingEvents: null,
      extraEvents: null,
    }
  }
}
