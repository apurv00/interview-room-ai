import type { ClientSession } from 'mongoose'
import {
  HireAssessmentExport,
  hireAssessmentExportObjectKey,
  type HireAssessmentExportCoordinate,
} from '@hire-decisions/models'
import {
  hireAssessmentExportStorage,
  type HireAssessmentExportStoragePort,
} from '@hire-decisions/services/hireAssessmentExportStorage'
import {
  ensureHireAssessmentExportCleanupTombstone,
  hireAssessmentExportCleanupNotBeforeAt,
} from '@hire-decisions/services/hireAssessmentExportCleanupService'

type CoordinateValue = string | { toString(): string }

interface ExportRecordForCleanup {
  _id: CoordinateValue
  workspaceId: CoordinateValue
  applicationId: CoordinateValue
  jobId: CoordinateValue
  candidateId: CoordinateValue
}

export interface HireAssessmentExportCleanupTarget {
  key: string
  coordinate: HireAssessmentExportCoordinate
  /** Recovery must retain the tombstone through this worker quiescence horizon. */
  cleanupNotBeforeAt: Date
}

export interface CancelHireAssessmentExportsInput {
  /** Every caller supplies the strongest lifecycle coordinate it owns. */
  scope: Record<string, unknown>
  cancelledAt: Date
  session: ClientSession
  /** Privacy deletion and retention persist this durable redaction marker. */
  privacyRedactedAt?: Date
  storage?: HireAssessmentExportStoragePort
}

function cleanupTarget(
  record: ExportRecordForCleanup,
  cancelledAt: Date,
): HireAssessmentExportCleanupTarget {
  const coordinate = {
    workspaceId: record.workspaceId.toString(),
    jobId: record.jobId.toString(),
    applicationId: record.applicationId.toString(),
    candidateId: record.candidateId.toString(),
    exportId: record._id.toString(),
  }
  // The lifecycle can race a worker after its final authorization but before
  // R2 upload. Retain its tombstone for a full claim lease plus a second
  // quiescence lease; only the later all-workspace sweep can settle it.
  return {
    key: hireAssessmentExportObjectKey(coordinate),
    coordinate,
    cleanupNotBeforeAt: hireAssessmentExportCleanupNotBeforeAt(cancelledAt),
  }
}

/**
 * R2 deletion is idempotent. Callers invoke this after the cancellation
 * transaction commits for prompt best-effort cleanup. Crucially, this does
 * not settle the durable tombstone: an old worker may upload after this first
 * delete using a pre-cancellation lease. The all-workspace sweep deletes and
 * settles only after `cleanupNotBeforeAt`.
 */
export async function deleteHireAssessmentExportObjects(
  targets: readonly HireAssessmentExportCleanupTarget[],
  storage: HireAssessmentExportStoragePort = hireAssessmentExportStorage,
): Promise<void> {
  for (const target of targets) {
    await storage.delete(target)
  }
}

/**
 * Write a deletion-only tombstone before redacting each still-live export.
 * The tombstone has immutable IDs only and survives hard workspace purge, so
 * its global recovery sweep can remove a late worker upload even when the
 * parent export row and workspace root no longer exist.
 */
export async function cancelHireAssessmentExports(
  input: CancelHireAssessmentExportsInput,
): Promise<HireAssessmentExportCleanupTarget[]> {
  const rows = await HireAssessmentExport.find({
    ...input.scope,
    status: { $ne: 'cancelled' },
  })
    .select('_id workspaceId applicationId jobId candidateId')
    .session(input.session)
    .lean() as ExportRecordForCleanup[]
  const cleanup = rows.map((row) => ({
    row,
    target: cleanupTarget(row, input.cancelledAt),
  }))
  const targets = cleanup.map(({ target }) => target)

  if (cleanup.length) {
    // MongoDB transactions do not support parallel operations on one session.
    // The tombstone must be durable before the subsequent redaction update.
    for (const { target } of cleanup) {
      await ensureHireAssessmentExportCleanupTombstone({
        coordinate: target.coordinate,
        requestedAt: input.cancelledAt,
        session: input.session,
      })
    }
  }

  await HireAssessmentExport.updateMany(
    {
      ...input.scope,
      status: { $ne: 'cancelled' },
    },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: input.cancelledAt,
        ...(input.privacyRedactedAt
          ? { privacyRedactedAt: input.privacyRedactedAt }
          : {}),
        objectCleanupPendingAt: input.cancelledAt,
      },
      $unset: {
        decisionSnapshot: 1,
        objectKey: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextRetryAt: 1,
        objectCleanupCompletedAt: 1,
        objectCleanupClaimToken: 1,
        objectCleanupLeaseExpiresAt: 1,
      },
    },
    { session: input.session, overwriteImmutable: true },
  )
  return targets
}
