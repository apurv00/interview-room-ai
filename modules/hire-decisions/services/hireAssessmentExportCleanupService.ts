import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { logger } from '@shared/logger'
import {
  HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS,
  HIRE_ASSESSMENT_EXPORT_LEASE_MS,
  HireAssessmentExport,
  hireAssessmentExportObjectKey,
  type HireAssessmentExportCoordinate,
} from '../models/HireAssessmentExport'
import {
  HIRE_ASSESSMENT_EXPORT_CLEANUP_LEASE_MS,
  HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT,
  HIRE_ASSESSMENT_EXPORT_MAX_PUT_SETTLEMENT_MS,
  HireAssessmentExportCleanup,
  type IHireAssessmentExportCleanup,
} from '../models/HireAssessmentExportCleanup'
import { connectHireDecisionDB } from './hireDecisionBoundary'
import { hireAssessmentExportStorage } from './hireAssessmentExportStorage'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60_000

export type HireAssessmentExportCleanupProcessResult =
  | 'deleted'
  | 'retry_scheduled'
  | 'skipped'

function cleanupObjectId(value: string): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new Error('Hire assessment export cleanup coordinate is invalid')
  return new mongoose.Types.ObjectId(value)
}

/**
 * A cancellation retains its cleanup obligation through one full possible
 * worker lease plus the bounded settlement window for a PutObject that began
 * before its absolute lease deadline. The storage port rejects any later
 * start, so one successful delete after this point may settle the tombstone.
 */
export function hireAssessmentExportCleanupNotBeforeAt(requestedAt: Date): Date {
  return new Date(
    requestedAt.getTime() +
    HIRE_ASSESSMENT_EXPORT_LEASE_MS +
    HIRE_ASSESSMENT_EXPORT_MAX_PUT_SETTLEMENT_MS,
  )
}

/**
 * Persist this before a caller redacts/cancels its parent export. Upsert is
 * safe across lifecycle, expiry, and worker-failure races because the key is
 * the immutable workspace/export pair and all persisted values are IDs only.
 */
export async function ensureHireAssessmentExportCleanupTombstone(input: {
  coordinate: HireAssessmentExportCoordinate
  requestedAt: Date
  session?: ClientSession
}): Promise<Date> {
  const cleanupNotBeforeAt = hireAssessmentExportCleanupNotBeforeAt(input.requestedAt)
  const workspaceId = cleanupObjectId(input.coordinate.workspaceId)
  const applicationId = cleanupObjectId(input.coordinate.applicationId)
  const jobId = cleanupObjectId(input.coordinate.jobId)
  const candidateId = cleanupObjectId(input.coordinate.candidateId)
  const exportId = cleanupObjectId(input.coordinate.exportId)
  await HireAssessmentExportCleanup.updateOne(
    { workspaceId, exportId },
    {
      $setOnInsert: {
        workspaceId,
        applicationId,
        jobId,
        candidateId,
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
  row: Pick<IHireAssessmentExportCleanup, 'workspaceId' | 'applicationId' | 'jobId' | 'candidateId' | 'exportId'>,
): HireAssessmentExportCoordinate {
  return {
    workspaceId: row.workspaceId.toString(),
    jobId: row.jobId.toString(),
    applicationId: row.applicationId.toString(),
    candidateId: row.candidateId.toString(),
    exportId: row.exportId.toString(),
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
}): Promise<IHireAssessmentExportCleanup | null> {
  const claimToken = randomUUID()
  return HireAssessmentExportCleanup.findOneAndUpdate(
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
          leaseExpiresAt: new Date(input.now.getTime() + HIRE_ASSESSMENT_EXPORT_CLEANUP_LEASE_MS),
          // Mark the initial lane at the atomic claim itself. If this worker
          // crashes before defer/delete, its expired claim re-enters the
          // retry lane instead of monopolizing fresh cancellation capacity.
          firstSweepAt: { $ifNull: ['$firstSweepAt', input.now] },
          attempts: { $add: ['$attempts', 1] },
        },
      },
    ],
    { new: true, timestamps: false },
  ).select('+claimToken')
}

async function deferCleanup(input: {
  row: IHireAssessmentExportCleanup
  now: Date
}): Promise<void> {
  await HireAssessmentExportCleanup.updateOne(
    {
      _id: input.row._id,
      claimToken: input.row.claimToken,
    },
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
 * Atomically reserve the parent only when it is terminal and cannot become a
 * newly-ready retry. R2 has no transaction with Mongo, so this CAS is the
 * coordination point that makes the following delete safe.
 */
async function claimTerminalParentForCleanup(input: {
  row: IHireAssessmentExportCleanup
  now: Date
}): Promise<ParentCleanupGate> {
  const claimed = await HireAssessmentExport.findOneAndUpdate(
    {
      _id: input.row.exportId,
      workspaceId: input.row.workspaceId,
      objectCleanupPendingAt: { $exists: true },
      $and: [
        {
          $or: [
            { status: 'cancelled' },
            {
              status: 'failed',
              attempts: { $gte: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
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
          input.now.getTime() + HIRE_ASSESSMENT_EXPORT_CLEANUP_LEASE_MS,
        ),
      },
    },
    { new: true },
  ).select('+objectCleanupClaimToken')
  if (claimed) return 'claimed'

  const current = await HireAssessmentExport.findOne({
    _id: input.row.exportId,
    workspaceId: input.row.workspaceId,
  })
    .select('status attempts nextRetryAt objectCleanupPendingAt +objectCleanupClaimToken +objectCleanupLeaseExpiresAt')
    .lean()
  if (!current) return 'absent'

  if (!current.objectCleanupPendingAt) return 'stale'

  const retryable =
    current.status === 'pending' ||
    current.status === 'generating' ||
    current.status === 'ready' ||
    (current.status === 'failed' && current.attempts < HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS)
  return retryable ? 'stale' : 'contended'
}

async function releaseParentCleanupClaim(row: IHireAssessmentExportCleanup): Promise<void> {
  await HireAssessmentExport.updateOne(
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
  row: IHireAssessmentExportCleanup
  now: Date
}): Promise<void> {
  await HireAssessmentExport.updateOne(
    {
      _id: input.row.exportId,
      workspaceId: input.row.workspaceId,
      objectCleanupClaimToken: input.row.claimToken,
      $or: [
        { status: 'cancelled' },
        {
          status: 'failed',
          attempts: { $gte: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
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

/**
 * Global deletion-only sweep. It intentionally does not require an active
 * workspace or member: a tombstone may be the last surviving control record
 * after hard purge, and its exact immutable coordinates can only delete that
 * one deterministic private R2 object.
 */
export async function processHireAssessmentExportCleanup(input: {
  cleanupId: string
  now?: Date
}): Promise<HireAssessmentExportCleanupProcessResult> {
  await connectHireDecisionDB()
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
    // A retry won or the parent became ready. This obligation was from an
    // older ambiguous upload; deleting its deterministic key would delete the
    // valid replacement, so retire only the tombstone.
    await HireAssessmentExportCleanup.deleteOne({
      _id: claimed._id,
      claimToken: claimed.claimToken,
    })
    return 'skipped'
  }
  if (parentGate === 'contended') {
    await deferCleanup({ row: claimed, now })
    return 'retry_scheduled'
  }
  try {
    await hireAssessmentExportStorage.delete({
      key: hireAssessmentExportObjectKey(coordinate),
      coordinate,
    })

    // An absent parent is the expected hard-purge case. A claimed parent is
    // terminal and CAS-reserved above, so no retry can make it ready between
    // this point and the delete.
    if (parentGate === 'claimed') await settleParentCleanup({ row: claimed, now })
    const settled = await HireAssessmentExportCleanup.deleteOne({
      _id: claimed._id,
      claimToken: claimed.claimToken,
    })
    if (settled.deletedCount !== 1) return 'skipped'
    return 'deleted'
  } catch (error) {
    if (parentGate === 'claimed') await releaseParentCleanupClaim(claimed)
    await deferCleanup({ row: claimed, now: new Date() })
    logger.warn({ cleanupId: claimed._id.toString() }, 'hire: assessment export object cleanup deferred')
    return 'retry_scheduled'
  }
}

/**
 * The query is deliberately global and bounded. Export rows are no longer a
 * reliable source after workspace hard purge; these tiny tombstones are.
 */
export async function listDueHireAssessmentExportCleanupIds(input?: {
  limit?: number
  now?: Date
}): Promise<string[]> {
  await connectHireDecisionDB()
  const now = input?.now ?? new Date()
  const limit = Math.min(
    Math.max(1, input?.limit ?? HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT),
    HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT,
  )
  const dueFilter = {
    cleanupNotBeforeAt: { $lte: now },
    $or: [
      {
        leaseExpiresAt: { $exists: false },
        nextRetryAt: { $lte: now },
      },
      { leaseExpiresAt: { $lte: now } },
    ],
  }
  // Never-swept tombstones are a finite, high-priority lane. It prevents a
  // large backlog of old retry failures from starving a newly cancelled or
  // hard-purged export past its bounded deletion deadline.
  const freshRows = await HireAssessmentExportCleanup.find({
    ...dueFilter,
    firstSweepAt: { $exists: false },
  })
    .sort({ cleanupNotBeforeAt: 1, nextRetryAt: 1, _id: 1 })
    .limit(limit)
    .select('_id')
    .lean()
  if (freshRows.length >= limit) return freshRows.map((row) => row._id.toString())

  const retryRows = await HireAssessmentExportCleanup.find({
    ...dueFilter,
    firstSweepAt: { $exists: true },
  })
    .sort({ nextRetryAt: 1, cleanupNotBeforeAt: 1, _id: 1 })
    .limit(limit - freshRows.length)
    .select('_id')
    .lean()
  return [...freshRows, ...retryRows].map((row) => row._id.toString())
}

export const __hireAssessmentExportCleanup = {
  cleanupCoordinate,
  retryDueAt,
}
