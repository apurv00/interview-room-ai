import { connectDB } from '@shared/db/connection'
import { JobApplication, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'
import type { Types } from 'mongoose'
import {
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

const DAY_MS = 24 * 60 * 60 * 1000
export const TRACKER_GHOST_AFTER_DAYS = 35
export const TRACKER_STATUS_SWEEP_LIMIT = 500
export const TRACKER_STATUS_SWEEP_INDEX_NAME = 'jobs_tracker_status_sweep_due'
export const TRACKER_STATUS_SWEEP_INDEX_KEY = { status: 1, appliedAt: 1, _id: 1 } as const
export const TRACKER_STATUS_SWEEP_INDEX_PARTIAL = {
  status: 'applied',
  appliedAt: { $type: 'date' },
} as const

interface TrackerStatusSweepIndex {
  name?: string
  key?: Record<string, unknown>
  partialFilterExpression?: Record<string, unknown>
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  expireAfterSeconds?: number
  collation?: unknown
}

function exactObjectKeys(
  value: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!value) return false
  const keys = Object.keys(value)
  return keys.length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
}

export function isExactTrackerStatusSweepIndex(index: TrackerStatusSweepIndex): boolean {
  const appliedAt = index.partialFilterExpression?.appliedAt as Record<string, unknown> | undefined
  return index.name === TRACKER_STATUS_SWEEP_INDEX_NAME &&
    exactObjectKeys(index.key, TRACKER_STATUS_SWEEP_INDEX_KEY) &&
    index.partialFilterExpression?.status === 'applied' &&
    exactObjectKeys(appliedAt, { $type: 'date' }) &&
    Object.keys(index.partialFilterExpression ?? {}).length === 2 &&
    index.unique !== true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.expireAfterSeconds === undefined &&
    index.collation === undefined
}

export class TrackerStatusSweepIndexRequiredError extends Error {
  constructor() {
    super(`Jobs tracker status sweep requires exact index ${TRACKER_STATUS_SWEEP_INDEX_NAME}`)
    this.name = 'TrackerStatusSweepIndexRequiredError'
  }
}

export function assertTrackerStatusSweepIndex(indexes: TrackerStatusSweepIndex[]): void {
  if (!indexes.some(isExactTrackerStatusSweepIndex)) {
    throw new TrackerStatusSweepIndexRequiredError()
  }
}

interface TrackerStatusCandidate {
  _id: Types.ObjectId
  userId: Types.ObjectId
  jobPostingId: Types.ObjectId
  appliedAt: Date
  updatedAt: Date
}

export interface TrackerStatusSweepOptions {
  now?: Date
  limit?: number
}

export interface TrackerStatusSweepReport {
  at: string
  cutoff: string
  limit: number
  scanned: number
  ghosted: number
  raced: number
  accountInactive: number
  capped: boolean
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return TRACKER_STATUS_SWEEP_LIMIT
  }
  return Math.min(TRACKER_STATUS_SWEEP_LIMIT, Math.max(1, Math.floor(requested)))
}

/**
 * Applies the 35-day reversible inference outside every user-facing read.
 *
 * `appliedAt` is the user's explicit application confirmation. Rows that only
 * record an apply-link click (or legacy rows without that confirmation date)
 * are deliberately ineligible. Every winning transition and its audit event
 * share the account-deletion transaction fence; exact snapshot predicates
 * prevent this worker from overwriting a concurrent user correction.
 */
export async function runTrackerStatusSweep(
  options: TrackerStatusSweepOptions = {},
): Promise<TrackerStatusSweepReport> {
  await connectDB()
  // Performance is a safety boundary for a global scheduled scan. Fail
  // before reading user rows unless the non-dropping rollout gate built and
  // verified the exact partial due-work index.
  assertTrackerStatusSweepIndex(await JobApplication.collection.indexes())
  const now = options.now ?? new Date()
  const limit = boundedLimit(options.limit)
  const cutoff = new Date(now.getTime() - TRACKER_GHOST_AFTER_DAYS * DAY_MS)

  const discovered = await JobApplication.find({
    status: 'applied',
    appliedAt: { $type: 'date', $lte: cutoff },
  })
    .select('_id userId jobPostingId appliedAt updatedAt')
    .sort({ appliedAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean<TrackerStatusCandidate[]>()

  const candidates = discovered.slice(0, limit)
  const byUser = new Map<string, TrackerStatusCandidate[]>()
  for (const candidate of candidates) {
    const userId = String(candidate.userId)
    const rows = byUser.get(userId) ?? []
    rows.push(candidate)
    byUser.set(userId, rows)
  }

  let ghosted = 0
  let raced = 0
  let accountInactive = 0

  for (const [userId, rows] of Array.from(byUser.entries())) {
    try {
      const result = await withActiveJobsAccountWrite(userId, async (session) => {
        let transactionGhosted = 0
        let transactionRaced = 0
        const events: Array<Record<string, unknown>> = []

        for (const candidate of rows) {
          const write = await JobApplication.updateOne(
            {
              _id: candidate._id,
              userId: candidate.userId,
              jobPostingId: candidate.jobPostingId,
              status: 'applied',
              appliedAt: candidate.appliedAt,
              updatedAt: candidate.updatedAt,
            },
            {
              $set: { status: 'ghosted', ghostSuggestedAt: now },
              $push: {
                statusHistory: { status: 'ghosted', at: now, source: 'system' },
              },
            },
            { session },
          )

          if ((write.modifiedCount ?? 0) !== 1) {
            transactionRaced += 1
            continue
          }

          transactionGhosted += 1
          events.push({
            name: 'jobs.ghost_auto',
            userId: candidate.userId,
            jobPostingId: candidate.jobPostingId,
            applicationId: candidate._id,
            props: { count: 1, reason: 'applied-silent-35d' },
            ts: now,
          })
        }

        if (events.length > 0) {
          await ProductEvent.create(events, { session })
        }
        return { ghosted: transactionGhosted, raced: transactionRaced }
      })
      ghosted += result.ghosted
      raced += result.raced
    } catch (error) {
      if (error instanceof JobsAccountInactiveError) {
        accountInactive += rows.length
        continue
      }
      throw error
    }
  }

  const report: TrackerStatusSweepReport = {
    at: now.toISOString(),
    cutoff: cutoff.toISOString(),
    limit,
    scanned: candidates.length,
    ghosted,
    raced,
    accountInactive,
    capped: discovered.length > limit,
  }

  if (report.capped || report.accountInactive > 0) {
    logger.warn({ report }, 'jobs tracker status sweep completed with deferred or inactive rows')
  } else {
    logger.info({ report }, 'jobs tracker status sweep complete')
  }
  return report
}
