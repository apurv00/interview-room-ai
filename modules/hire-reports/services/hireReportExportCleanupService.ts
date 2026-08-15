import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { logger } from '@shared/logger'
import {
  HIRE_REPORT_EXPORT_LEASE_MS,
  HIRE_REPORT_EXPORT_MAX_ATTEMPTS,
  HireReportExport,
  hireReportExportObjectKey,
  type HireReportExportCoordinate,
} from '../models/HireReportExport'
import {
  HIRE_REPORT_EXPORT_CLEANUP_LEASE_MS,
  HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT,
  HIRE_REPORT_EXPORT_MAX_PUT_SETTLEMENT_MS,
  HireReportExportCleanup,
  type IHireReportExportCleanup,
} from '../models/HireReportExportCleanup'
import { connectHireReportDB } from './hireReportBoundary'
import { hireReportExportStorage } from './hireReportExportStorage'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

export type HireReportExportCleanupProcessResult =
  | 'deleted'
  | 'retry_scheduled'
  | 'skipped'

function cleanupObjectId(value: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new Error('Hire report export cleanup coordinate is invalid')
  return new mongoose.Types.ObjectId(value)
}

/**
 * A tombstone waits through a full possible export lease and the bounded
 * settlement window for a PutObject that started before that lease expired.
 */
export function hireReportExportCleanupNotBeforeAt(requestedAt: Date): Date {
  return new Date(
    requestedAt.getTime() +
    HIRE_REPORT_EXPORT_LEASE_MS +
    HIRE_REPORT_EXPORT_MAX_PUT_SETTLEMENT_MS,
  )
}

/**
 * Persist this before a caller cancels or redacts its parent report. A record
 * contains only the immutable coordinates needed to derive one private key.
 */
export async function ensureHireReportExportCleanupTombstone(input: {
  coordinate: HireReportExportCoordinate
  requestedAt: Date
  session?: ClientSession
}): Promise<Date> {
  const cleanupNotBeforeAt = hireReportExportCleanupNotBeforeAt(input.requestedAt)
  const workspaceId = cleanupObjectId(input.coordinate.workspaceId)
  const exportId = cleanupObjectId(input.coordinate.reportId)
  const jobId = input.coordinate.jobId ? cleanupObjectId(input.coordinate.jobId) : undefined
  await HireReportExportCleanup.updateOne(
    { workspaceId, exportId },
    {
      $setOnInsert: {
        workspaceId,
        ...(jobId ? { jobId } : {}),
        reportKind: input.coordinate.reportKind,
        reportScope: input.coordinate.reportScope,
        format: input.coordinate.format,
        exportId,
        requestedAt: input.requestedAt,
        cleanupNotBeforeAt,
        attempts: 0,
        nextRetryAt: cleanupNotBeforeAt,
      },
    },
    { upsert: true, ...(input.session ? { session: input.session } : {}) },
  )
  return cleanupNotBeforeAt
}

function cleanupCoordinate(
  row: Pick<IHireReportExportCleanup,
    'workspaceId' | 'jobId' | 'reportKind' | 'reportScope' | 'format' | 'exportId'
  >,
): HireReportExportCoordinate {
  return {
    workspaceId: row.workspaceId.toString(),
    reportId: row.exportId.toString(),
    reportKind: row.reportKind,
    reportScope: row.reportScope,
    format: row.format,
    ...(row.jobId ? { jobId: row.jobId.toString() } : {}),
  }
}

function retryDueAt(now: Date, attempts: number): Date {
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 6)),
  )
  return new Date(now.getTime() + delay)
}

async function claimCleanup(input: {
  cleanupId: mongoose.Types.ObjectId
  now: Date
}): Promise<IHireReportExportCleanup | null> {
  const claimToken = randomUUID()
  return HireReportExportCleanup.findOneAndUpdate(
    {
      _id: input.cleanupId,
      cleanupNotBeforeAt: { $lte: input.now },
      $or: [
        {
          leaseExpiresAt: { $exists: false },
          nextRetryAt: { $lte: input.now },
        },
        { leaseExpiresAt: { $lte: input.now } },
      ],
    },
    [
      {
        $set: {
          claimToken,
          leaseExpiresAt: new Date(input.now.getTime() + HIRE_REPORT_EXPORT_CLEANUP_LEASE_MS),
          firstSweepAt: { $ifNull: ['$firstSweepAt', input.now] },
          attempts: { $add: ['$attempts', 1] },
        },
      },
    ],
    { new: true, timestamps: false },
  ).select('+claimToken')
}

async function deferCleanup(input: {
  row: IHireReportExportCleanup
  now: Date
}): Promise<void> {
  await HireReportExportCleanup.updateOne(
    { _id: input.row._id, claimToken: input.row.claimToken },
    {
      $set: {
        lastFailureAt: input.now,
        ...(input.row.firstSweepAt ? {} : { firstSweepAt: input.now }),
        nextRetryAt: retryDueAt(input.now, input.row.attempts),
      },
      $unset: { claimToken: 1, leaseExpiresAt: 1 },
    },
    { timestamps: false },
  )
}

type ParentCleanupGate = 'claimed' | 'absent' | 'stale' | 'contended'

/**
 * R2 has no transaction with Mongo. This reservation prevents an old cleanup
 * tombstone from deleting a report object that a newer retry just made ready.
 */
async function claimTerminalParentForCleanup(input: {
  row: IHireReportExportCleanup
  now: Date
}): Promise<ParentCleanupGate> {
  const claimed = await HireReportExport.findOneAndUpdate(
    {
      _id: input.row.exportId,
      workspaceId: input.row.workspaceId,
      objectCleanupPendingAt: { $exists: true },
      $and: [
        {
          $or: [
            { status: 'cancelled' },
            { status: 'expired' },
            {
              status: 'failed',
              attempts: { $gte: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
              nextRetryAt: { $exists: false },
            },
          ],
        },
        {
          $or: [
            { objectCleanupClaimToken: { $exists: false } },
            { objectCleanupLeaseExpiresAt: { $lte: input.now } },
          ],
        },
      ],
    },
    {
      $set: {
        objectCleanupClaimToken: input.row.claimToken,
        objectCleanupLeaseExpiresAt: new Date(
          input.now.getTime() + HIRE_REPORT_EXPORT_CLEANUP_LEASE_MS,
        ),
      },
    },
    { new: true },
  ).select('+objectCleanupClaimToken')
  if (claimed) return 'claimed'

  const current = await HireReportExport.findOne({
    _id: input.row.exportId,
    workspaceId: input.row.workspaceId,
  })
    .select('status attempts nextRetryAt objectCleanupPendingAt +objectCleanupClaimToken +objectCleanupLeaseExpiresAt')
    .lean()
  if (!current) return 'absent'
  if (!current.objectCleanupPendingAt) return 'stale'

  const retryable =
    current.status === 'requested' ||
    current.status === 'generating' ||
    current.status === 'ready' ||
    (current.status === 'failed' && current.attempts < HIRE_REPORT_EXPORT_MAX_ATTEMPTS)
  return retryable ? 'stale' : 'contended'
}

async function releaseParentCleanupClaim(row: IHireReportExportCleanup): Promise<void> {
  await HireReportExport.updateOne(
    {
      _id: row.exportId,
      workspaceId: row.workspaceId,
      objectCleanupClaimToken: row.claimToken,
    },
    { $unset: { objectCleanupClaimToken: 1, objectCleanupLeaseExpiresAt: 1 } },
    { timestamps: false, overwriteImmutable: true },
  )
}

async function settleParentCleanup(input: {
  row: IHireReportExportCleanup
  now: Date
}): Promise<void> {
  await HireReportExport.updateOne(
    {
      _id: input.row.exportId,
      workspaceId: input.row.workspaceId,
      objectCleanupClaimToken: input.row.claimToken,
      $or: [
        { status: 'cancelled' },
        { status: 'expired' },
        {
          status: 'failed',
          attempts: { $gte: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
          nextRetryAt: { $exists: false },
        },
      ],
    },
    {
      $set: { objectCleanupCompletedAt: input.now },
      $unset: {
        objectCleanupPendingAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { timestamps: false, overwriteImmutable: true },
  )
}

/** A global, deletion-only worker path; it needs no live member capability. */
export async function processHireReportExportCleanup(input: {
  cleanupId: string
  now?: Date
}): Promise<HireReportExportCleanupProcessResult> {
  await connectHireReportDB()
  if (!OBJECT_ID.test(input.cleanupId)) return 'skipped'
  const now = input.now ?? new Date()
  const claimed = await claimCleanup({
    cleanupId: new mongoose.Types.ObjectId(input.cleanupId),
    now,
  })
  if (!claimed?.claimToken) return 'skipped'

  const coordinate = cleanupCoordinate(claimed)
  const parentGate = await claimTerminalParentForCleanup({ row: claimed, now })
  if (parentGate === 'stale') {
    await HireReportExportCleanup.deleteOne({ _id: claimed._id, claimToken: claimed.claimToken })
    return 'skipped'
  }
  if (parentGate === 'contended') {
    await deferCleanup({ row: claimed, now })
    return 'retry_scheduled'
  }
  try {
    await hireReportExportStorage.delete({
      key: hireReportExportObjectKey(coordinate),
      coordinate,
    })
    if (parentGate === 'claimed') await settleParentCleanup({ row: claimed, now })
    const settled = await HireReportExportCleanup.deleteOne({
      _id: claimed._id,
      claimToken: claimed.claimToken,
    })
    return settled.deletedCount === 1 ? 'deleted' : 'skipped'
  } catch {
    if (parentGate === 'claimed') await releaseParentCleanupClaim(claimed)
    await deferCleanup({ row: claimed, now: new Date() })
    logger.warn({ reportExportCleanupId: claimed._id.toString() }, 'hire: report export object cleanup deferred')
    return 'retry_scheduled'
  }
}

/**
 * A bounded global sweep gives never-swept tombstones priority over a retry
 * backlog, so a fresh cancellation cannot be starved indefinitely.
 */
export async function listDueHireReportExportCleanupIds(input?: {
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireReportDB()
  const now = input?.now ?? new Date()
  const limit = Math.min(
    Math.max(1, input?.limit ?? HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT),
    HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT,
  )
  const dueFilter = {
    cleanupNotBeforeAt: { $lte: now },
    $or: [
      { leaseExpiresAt: { $exists: false }, nextRetryAt: { $lte: now } },
      { leaseExpiresAt: { $lte: now } },
    ],
  }
  const freshRows = await HireReportExportCleanup.find({
    ...dueFilter,
    firstSweepAt: { $exists: false },
  })
    .sort({ cleanupNotBeforeAt: 1, nextRetryAt: 1, _id: 1 })
    .limit(limit)
    .select('_id')
    .lean()
  if (freshRows.length >= limit) return freshRows.map((row) => row._id.toString())

  const retryRows = await HireReportExportCleanup.find({
    ...dueFilter,
    firstSweepAt: { $exists: true },
  })
    .sort({ nextRetryAt: 1, cleanupNotBeforeAt: 1, _id: 1 })
    .limit(limit - freshRows.length)
    .select('_id')
    .lean()
  return freshRows.concat(retryRows).map((row) => row._id.toString())
}

export const __hireReportExportCleanup = {
  cleanupCoordinate,
  retryDueAt,
}
