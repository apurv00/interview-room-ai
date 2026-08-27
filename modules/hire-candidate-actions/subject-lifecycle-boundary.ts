import type mongoose from 'mongoose'
import type { ClientSession } from 'mongoose'
import { deleteHireCandidateSelectionSubjectData } from '../hire-operations/purge-boundary'
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
  HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS,
} from './models'

/**
 * Remove a candidate's join coordinate from durable bulk audit rows while
 * retaining non-identifying aggregate operation counts. A live work item is
 * terminally conflicted first so no worker can apply it after erasure wins.
 */
export async function redactHireCandidateActionSubjectData(input: {
  workspaceId: mongoose.Types.ObjectId
  applicationIds: mongoose.Types.ObjectId[]
  at: Date
  session: ClientSession
}): Promise<void> {
  if (!input.session.inTransaction()) {
    throw new Error('Hire candidate action redaction requires a transaction')
  }
  if (input.applicationIds.length === 0) return
  await deleteHireCandidateSelectionSubjectData({
    workspaceId: input.workspaceId,
    applicationIds: input.applicationIds,
    session: input.session,
  })
  const scope = {
    workspaceId: input.workspaceId,
    applicationId: { $in: input.applicationIds },
    privacyRedactedAt: { $exists: false },
  }
  const operationIds = await HireCandidateBulkOperationItem.distinct(
    'bulkOperationId',
    scope,
  ).session(input.session)
  await HireCandidateBulkOperationItem.updateMany(
    { ...scope, status: { $in: ['queued', 'processing'] } },
    {
      $set: {
        status: 'conflict',
        outcomeCode: 'CANDIDATE_PRIVACY_UNAVAILABLE',
        processedAt: input.at,
      },
    },
    { session: input.session },
  )
  await HireCandidateBulkOperationItem.updateMany(
    scope,
    {
      $set: { privacyRedactedAt: input.at },
      $min: {
        purgeAt: new Date(input.at.getTime() + HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS),
      },
      $unset: {
        applicationId: 1,
        rowOperationId: 1,
        claimToken: 1,
        leaseExpiresAt: 1,
        nextAttemptAt: 1,
      },
    },
    { session: input.session, overwriteImmutable: true },
  )
  if (operationIds.length > 0) {
    await HireCandidateBulkOperation.updateMany(
      {
        _id: { $in: operationIds },
        workspaceId: input.workspaceId,
        status: { $in: ['queued', 'processing'] },
      },
      { $set: { nextRecoveryAt: input.at } },
      { session: input.session },
    )
  }
}
