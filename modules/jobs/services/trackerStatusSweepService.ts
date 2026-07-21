import { connectDB } from '@shared/db/connection'
import { JobApplication, ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'
import { Types } from 'mongoose'
import {
  activeJobsAccountIds,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'
import {
  JOBS_TRACKER_SWEEP_CURSOR_ID,
  TrackerStatusSweepCursor,
} from '../models/TrackerStatusSweepCursor'

const DAY_MS = 24 * 60 * 60 * 1000
export const TRACKER_GHOST_AFTER_DAYS = 35
export const TRACKER_STATUS_SWEEP_LIMIT = 500
export const TRACKER_STATUS_SWEEP_SCAN_LIMIT = 2_000
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

interface TrackerStatusSweepCursorSnapshot {
  appliedAt: Date
  applicationId: Types.ObjectId
}

interface RawTrackerStatusSweepCursorSnapshot {
  appliedAt?: unknown
  applicationId?: unknown
}

export interface TrackerStatusSweepOptions {
  now?: Date
  limit?: number
  scanLimit?: number
}

export interface TrackerStatusSweepReport {
  at: string
  cutoff: string
  limit: number
  scanLimit: number
  examined: number
  scanned: number
  ghosted: number
  raced: number
  prefilterInactive: number
  accountInactive: number
  capped: boolean
  cursorAdvanced: boolean
  cursorBlockedByRace: boolean
  cursorMalformed: boolean
  wrapped: boolean
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return TRACKER_STATUS_SWEEP_LIMIT
  }
  return Math.min(TRACKER_STATUS_SWEEP_LIMIT, Math.max(1, Math.floor(requested)))
}

function boundedScanLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return TRACKER_STATUS_SWEEP_SCAN_LIMIT
  }
  return Math.min(TRACKER_STATUS_SWEEP_SCAN_LIMIT, Math.max(1, Math.floor(requested)))
}

function dueCandidateFilter(
  cutoff: Date,
  cursor: TrackerStatusSweepCursorSnapshot | null,
): Record<string, unknown> {
  return {
    status: 'applied',
    appliedAt: { $type: 'date', $lte: cutoff },
    ...(cursor
      ? {
          $or: [
            { appliedAt: { $gt: cursor.appliedAt } },
            { appliedAt: cursor.appliedAt, _id: { $gt: cursor.applicationId } },
          ],
        }
      : {}),
  }
}

function validCursorSnapshot(
  cursor: RawTrackerStatusSweepCursorSnapshot | null,
): cursor is TrackerStatusSweepCursorSnapshot {
  if (!cursor || !(cursor.appliedAt instanceof Date)) return false
  if (!Number.isFinite(cursor.appliedAt.getTime())) return false
  return cursor.applicationId instanceof Types.ObjectId
}

function selectCandidateWindow(
  discovered: TrackerStatusCandidate[],
  activeUserIds: Set<string>,
  limit: number,
): {
  candidates: TrackerStatusCandidate[]
  boundary?: TrackerStatusCandidate
  overflow: boolean
} {
  const candidates: TrackerStatusCandidate[] = []
  let boundary: TrackerStatusCandidate | undefined

  for (const candidate of discovered) {
    if (activeUserIds.has(String(candidate.userId))) {
      if (candidates.length >= limit) {
        return { candidates, boundary, overflow: true }
      }
      candidates.push(candidate)
    }
    // Advance through every consumed inactive row, but never past an active
    // row deferred by the write cap.
    boundary = candidate
  }

  return { candidates, boundary, overflow: false }
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
  const scanLimit = boundedScanLimit(options.scanLimit)
  const cutoff = new Date(now.getTime() - TRACKER_GHOST_AFTER_DAYS * DAY_MS)

  const rawCursor = await TrackerStatusSweepCursor
    .findById(JOBS_TRACKER_SWEEP_CURSOR_ID)
    .select('appliedAt applicationId')
    .lean<RawTrackerStatusSweepCursorSnapshot | null>()
  const cursorMalformed = rawCursor !== null && !validCursorSnapshot(rawCursor)
  const storedCursor = validCursorSnapshot(rawCursor) ? rawCursor : null
  const discovered = await JobApplication
    .find(dueCandidateFilter(cutoff, storedCursor))
    .select('_id userId jobPostingId appliedAt updatedAt')
    .sort({ appliedAt: 1, _id: 1 })
    .limit(scanLimit)
    .hint(TRACKER_STATUS_SWEEP_INDEX_NAME)
    .lean<TrackerStatusCandidate[]>()
  const activeUserIds = discovered.length > 0
    ? await activeJobsAccountIds(discovered.map((candidate) => String(candidate.userId)))
    : new Set<string>()
  const selection = selectCandidateWindow(discovered, activeUserIds, limit)
  const candidates = selection.candidates
  const prefilterInactive = discovered.reduce(
    (count, candidate) => count + (activeUserIds.has(String(candidate.userId)) ? 0 : 1),
    0,
  )
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
  const racedApplicationIds = new Set<string>()

  for (const [userId, rows] of Array.from(byUser.entries())) {
    try {
      const result = await withActiveJobsAccountWrite(userId, async (session) => {
        let transactionGhosted = 0
        let transactionRaced = 0
        const transactionRacedApplicationIds: string[] = []
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
            transactionRacedApplicationIds.push(String(candidate._id))
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
        return {
          ghosted: transactionGhosted,
          raced: transactionRaced,
          racedApplicationIds: transactionRacedApplicationIds,
        }
      })
      ghosted += result.ghosted
      raced += result.raced
      for (const applicationId of result.racedApplicationIds) {
        racedApplicationIds.add(applicationId)
      }
    } catch (error) {
      if (error instanceof JobsAccountInactiveError) {
        accountInactive += rows.length
        continue
      }
      throw error
    }
  }

  const firstRacedIndex = discovered.findIndex((candidate) =>
    racedApplicationIds.has(String(candidate._id)),
  )
  const cursorBlockedByRace = firstRacedIndex >= 0
  const safeBoundary = firstRacedIndex > 0
    ? discovered[firstRacedIndex - 1]
    : firstRacedIndex === 0
      ? undefined
      : selection.boundary
  const exhausted = !selection.overflow && discovered.length < scanLimit
  let cursorAdvanced = false
  let wrapped = false
  if (exhausted && !cursorBlockedByRace) {
    if (rawCursor) {
      await TrackerStatusSweepCursor.deleteOne({ _id: JOBS_TRACKER_SWEEP_CURSOR_ID })
      wrapped = true
    }
  } else if (safeBoundary) {
    await TrackerStatusSweepCursor.updateOne(
      { _id: JOBS_TRACKER_SWEEP_CURSOR_ID },
      {
        $set: {
          appliedAt: safeBoundary.appliedAt,
          applicationId: safeBoundary._id,
          lastRunAt: now,
        },
      },
      { upsert: true },
    )
    cursorAdvanced = true
  } else if (!cursorBlockedByRace) {
    if (!exhausted) {
      throw new Error('jobs tracker status sweep could not checkpoint a non-exhausted scan')
    }
  } else if (cursorMalformed) {
    // A malformed cursor carries no trustworthy ordering information. Removing
    // it is safe because this bounded run started from the beginning and the
    // CAS loser remains eligible for the next run.
    await TrackerStatusSweepCursor.deleteOne({ _id: JOBS_TRACKER_SWEEP_CURSOR_ID })
  }

  const report: TrackerStatusSweepReport = {
    at: now.toISOString(),
    cutoff: cutoff.toISOString(),
    limit,
    scanLimit,
    examined: discovered.length,
    scanned: candidates.length,
    ghosted,
    raced,
    prefilterInactive,
    accountInactive,
    capped: selection.overflow || discovered.length === scanLimit,
    cursorAdvanced,
    cursorBlockedByRace,
    cursorMalformed,
    wrapped,
  }

  if (
    report.capped ||
    report.prefilterInactive > 0 ||
    report.accountInactive > 0 ||
    report.cursorBlockedByRace ||
    report.cursorMalformed
  ) {
    logger.warn(
      { report },
      'jobs tracker status sweep completed with deferred, inactive, or cursor-recovery rows',
    )
  } else {
    logger.info({ report }, 'jobs tracker status sweep complete')
  }
  return report
}
