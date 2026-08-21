import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import {
  HireAssessmentExport,
  HireExternalVerdict,
  HireSharePacket,
} from '@hire-decisions/models'
import { HireDigestOutbox, HireDigestPreference } from '../../hire-digest/models'
import { HireCandidateStatusLink } from '../../hire-status/models'
import {
  HireApplication,
  HireAiInviteDelivery,
  HireCandidate,
  HireConsentReceipt,
  HireEmailOutbox,
  HireEngineHandoff,
  HireEngineIngestionEvent,
  HireGuestSession,
  HireInterviewAttempt,
  HireInterviewResult,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewKit,
  HireIntakeTask,
  HireInvitationBatch,
  HireInvitationBatchItem,
  HireJob,
  HireJobRequirementVersion,
  HireMediaAsset,
  HireMemberSession,
  HireMemberSetup,
  HirePrivacyRequest,
  HireRound,
  HireScreeningGate,
  HireWorkspace,
  HireWorkspaceMember,
  type IHireMediaAsset,
  type IHireWorkspace,
} from '../models'
import { connectHireControlDB } from './hireControlBoundary'
import { deliverRuntimeRevocation } from './engineRevocationService'
import {
  hireMediaStorageKindForAsset,
  hireMediaStorage,
  type HireMediaCoordinate,
  type HireMediaStoragePort,
} from './hireMediaStorage'
import {
  hireWorkspaceBrandingStorage,
  hireWorkspaceLogoKey,
  type HireWorkspaceBrandingStoragePort,
} from '@hire-branding/services/workspaceBrandingStorage'
import {
  cancelHireAssessmentExports,
  deleteHireAssessmentExportObjects,
  type HireAssessmentExportCleanupTarget,
} from './assessmentExportLifecycleService'
import { HireReportExport } from '../../hire-reports/models/HireReportExport'
import { cancelHireReportExportsForLifecycle } from '../../hire-reports/services/hireReportLifecycleService'
import { HireOnboardingTestDrive } from '../../hire-onboarding/models'
import { HireDepartment } from '@hire-departments/models'
import {
  HireMultimodalAnalysis,
  HireMultimodalAnalysisIngestionEvent,
  HireMultimodalObservation,
  HireMultimodalObservationIngestionEvent,
  HireMultimodalObservationPurgeObligation,
} from '../../hire-multimodal/models'

const MEDIA_DELETE_BATCH_SIZE = 100
const RUNTIME_PURGE_DELIVERY_BATCH_SIZE = 25
const PURGE_LEASE_MS = 30 * 60 * 1000
const LEGACY_STAGING_GRACE_MS = 60 * 60 * 1000
const STALE_MEDIA_PURGE_CLAIM_MS = 15 * 60 * 1000

/**
 * Deliberate inventory of the complete Hire control-plane graph. The runtime
 * models live in a separate database and are intentionally absent. Keeping
 * this exported makes additions reviewable and lets the contract test fail if
 * this list is accidentally shortened.
 */
export const HIRE_WORKSPACE_PURGE_COLLECTIONS = [
  'HireMemberSetup',
  'HireMemberSession',
  'HireGuestSession',
  'HireConsentReceipt',
  'HireEngineHandoff',
  'HireEngineIngestionEvent',
  'HireMultimodalObservationIngestionEvent',
  'HireMultimodalObservation',
  'HireMultimodalObservationPurgeObligation',
  'HireMultimodalAnalysisIngestionEvent',
  'HireMultimodalAnalysis',
  'HireInterviewResult',
  'HireInterviewAttempt',
  'HireMediaAsset',
  'HirePrivacyRequest',
  'HireEmailOutbox',
  'HireDigestOutbox',
  'HireDigestPreference',
  'HireAiInviteDelivery',
  'HireHumanKitDelivery',
  'HireInterviewKit',
  'HireHumanScorecard',
  'HireHumanRound',
  'HireRound',
  'HireIntakeTask',
  'HireInvitationBatchItem',
  'HireInvitationBatch',
  'HireScreeningGate',
  'HireAssessmentExport',
  'HireReportExport',
  'HireExternalVerdict',
  'HireSharePacket',
  'HireCandidateStatusLink',
  'HireApplication',
  'HireCandidate',
  'HireJobRequirementVersion',
  'HireJob',
  'HireDepartment',
  'HireOnboardingTestDrive',
  'HireWorkspaceMember',
  'HireWorkspace',
] as const

export interface HireWorkspacePurgeReport {
  scanned: number
  claimed: number
  purged: number
  failed: number
  mediaObjectsDeleted: number
}

interface ClaimedWorkspace {
  workspace: IHireWorkspace
  claimToken: string
}

function mediaCoordinate(asset: IHireMediaAsset): HireMediaCoordinate {
  return {
    workspaceId: asset.workspaceId.toString(),
    applicationId: asset.applicationId.toString(),
    roundId: asset.roundId.toString(),
    attemptId: asset.attemptId.toString(),
    assetId: asset._id.toString(),
  }
}

function purgeFailureMessage(error: unknown): string {
  const value = error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'Workspace purge failed'
  return value.slice(0, 500)
}

function stagingWriterStillOwns(asset: IHireMediaAsset, now: Date): boolean {
  if (asset.state !== 'staging') return false
  if (asset.ingestionLeaseExpiresAt) {
    return asset.ingestionLeaseExpiresAt.getTime() > now.getTime()
  }
  if (asset.ingestionLeaseId) return true
  return !asset.createdAt
    || asset.createdAt.getTime() > now.getTime() - LEGACY_STAGING_GRACE_MS
}

async function claimWorkspaceForPurge(
  workspaceId: mongoose.Types.ObjectId,
  now: Date,
): Promise<ClaimedWorkspace | null> {
  const claimToken = randomUUID()
  const workspace = await HireWorkspace.findOneAndUpdate(
    {
      _id: workspaceId,
      lifecycleState: 'deletion_pending',
      purgeAfter: { $lte: now },
      $or: [
        { purgeState: { $exists: false } },
        { purgeState: 'pending' },
        { purgeState: 'failed' },
        { purgeState: 'claimed', purgeLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        purgeState: 'claimed',
        purgeClaimToken: claimToken,
        purgeLeaseExpiresAt: new Date(now.getTime() + PURGE_LEASE_MS),
      },
      $inc: { purgeAttempts: 1 },
      $unset: { purgeLastError: 1 },
    },
    { new: true, timestamps: false },
  )
  return workspace ? { workspace, claimToken } : null
}

async function renewWorkspacePurgeLease(
  workspaceId: mongoose.Types.ObjectId,
  claimToken: string,
  now: Date,
): Promise<void> {
  const result = await HireWorkspace.updateOne(
    { _id: workspaceId, purgeState: 'claimed', purgeClaimToken: claimToken },
    {
      $set: {
        purgeLeaseExpiresAt: new Date(now.getTime() + PURGE_LEASE_MS),
      },
    },
    { timestamps: false },
  )
  if (result.matchedCount !== 1) {
    throw new Error('Workspace purge lease was lost')
  }
}

async function releaseFailedWorkspacePurge(
  workspaceId: mongoose.Types.ObjectId,
  claimToken: string,
  error: unknown,
): Promise<void> {
  await HireWorkspace.updateOne(
    { _id: workspaceId, purgeState: 'claimed', purgeClaimToken: claimToken },
    {
      $set: {
        purgeState: 'failed',
        purgeLastError: purgeFailureMessage(error),
      },
      $unset: {
        purgeClaimToken: 1,
        purgeLeaseExpiresAt: 1,
      },
    },
    { timestamps: false },
  )
}

async function deleteWorkspaceMedia(
  workspaceId: mongoose.Types.ObjectId,
  claimToken: string,
  storage: HireMediaStoragePort,
  clock: () => Date,
): Promise<number> {
  let deleted = 0
  for (;;) {
    const assets = await HireMediaAsset.find({
      workspaceId,
      state: { $ne: 'purged' },
    })
      .select('+objectKeyNonce')
      .sort({ _id: 1 })
      .limit(MEDIA_DELETE_BATCH_SIZE)
    if (assets.length === 0) return deleted

    const claimAt = clock()
    if (assets.some((asset) => stagingWriterStillOwns(asset, claimAt))) {
      throw new Error('Workspace media ingestion lease is still active')
    }

    let firstFailure: unknown
    for (const candidate of assets) {
      const purgeClaimId = randomUUID()
      try {
        const asset = await HireMediaAsset.findOneAndUpdate(
          {
            _id: candidate._id,
            workspaceId,
            objectKey: candidate.objectKey,
            ...(candidate.objectKeyNonce
              ? { objectKeyNonce: candidate.objectKeyNonce }
              : { objectKeyNonce: { $exists: false } }),
            $or: [
              { state: { $in: ['ready', 'purge_failed'] } },
              {
                state: 'staging',
                ingestionLeaseExpiresAt: { $lte: claimAt },
              },
              {
                state: 'staging',
                ingestionLeaseId: { $exists: false },
                ingestionLeaseExpiresAt: { $exists: false },
                createdAt: { $lte: new Date(claimAt.getTime() - LEGACY_STAGING_GRACE_MS) },
              },
              ...(candidate.state === 'purge_claimed'
                && candidate.purgeClaimedAt
                && candidate.purgeClaimedAt.getTime()
                  <= claimAt.getTime() - STALE_MEDIA_PURGE_CLAIM_MS
                ? [{
                    state: 'purge_claimed' as const,
                    purgeClaimedAt: candidate.purgeClaimedAt,
                    ...(candidate.purgeClaimId
                      ? { purgeClaimId: candidate.purgeClaimId }
                      : { purgeClaimId: { $exists: false } }),
                  }]
                : []),
            ],
          },
          {
            $set: {
              state: 'purge_claimed',
              purgeClaimId,
              purgeClaimedAt: claimAt,
            },
            $unset: {
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
              purgeFailureCode: 1,
            },
          },
          { new: true },
        )
        if (!asset) throw new Error('Workspace media purge claim is no longer authoritative')
        // Logical deletion is idempotent: legacy keys are physically deleted,
        // while v2 keys receive the same permanent zero-byte seal on retry.
        await storage.delete({
          key: asset.objectKey,
          coordinate: mediaCoordinate(asset),
          kind: hireMediaStorageKindForAsset(candidate.kind),
          objectKeyNonce: candidate.objectKeyNonce,
        })
        const finalized = await HireMediaAsset.updateOne(
          {
            _id: asset._id,
            workspaceId,
            objectKey: asset.objectKey,
            state: 'purge_claimed',
            purgeClaimId,
          },
          {
            $set: { state: 'purged', purgedAt: clock() },
            $unset: {
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
              purgeClaimId: 1,
              purgeClaimedAt: 1,
              purgeFailureCode: 1,
            },
          },
        )
        if (finalized.modifiedCount !== 1) {
          throw new Error('Workspace media purge claim changed before finalization')
        }
        deleted += finalized.modifiedCount
      } catch (error) {
        await HireMediaAsset.updateOne(
          {
            _id: candidate._id,
            workspaceId,
            objectKey: candidate.objectKey,
            state: 'purge_claimed',
            purgeClaimId,
          },
          {
            $set: {
              state: 'purge_failed',
              purgeFailureCode: purgeFailureMessage(error).slice(0, 160),
            },
            $unset: {
              purgeClaimId: 1,
              purgeClaimedAt: 1,
              active: 1,
              ingestionLeaseId: 1,
              ingestionLeaseExpiresAt: 1,
            },
          },
        )
        firstFailure ??= error
      }
    }
    await renewWorkspacePurgeLease(workspaceId, claimToken, clock())
    if (firstFailure) throw firstFailure
  }
}

/**
 * Workspace branding is a single deterministic object, separate from
 * candidate media. Delete it under the same hard-purge lease so a soft-deleted
 * workspace cannot strand an R2 logo if an upload raced the lifecycle fence.
 */
async function deleteWorkspaceLogo(
  workspaceId: mongoose.Types.ObjectId,
  storage: HireWorkspaceBrandingStoragePort,
): Promise<void> {
  await storage.delete({ key: hireWorkspaceLogoKey(workspaceId.toString()) })
}

async function requestAndConfirmWorkspaceRuntimePurge(
  workspaceId: mongoose.Types.ObjectId,
  claimToken: string,
  now: Date,
  clock: () => Date,
): Promise<void> {
  // The 30-day soft-delete window remains recoverable: only a due hard purge
  // upgrades ordinary revocations to personal-data deletion. Mark every
  // control round, not only rounds with a result-linked runtimeSessionId. A
  // runtime binding can be provisioned before the control plane learns that
  // session id; the runtime's exact-coordinate tombstone safely acknowledges
  // rounds that never provisioned and closes that race.
  await HireRound.updateMany(
    {
      workspaceId,
      runtimePurgedAt: { $exists: false },
      revokedAt: { $exists: false },
    },
    {
      $set: {
        revokedAt: now,
        revocationReason: 'Workspace retention period elapsed',
      },
      $unset: { live: 1 },
    },
  )
  await HireRound.updateMany(
    { workspaceId, runtimePurgedAt: { $exists: false } },
    {
      $set: {
        runtimePurgeRequested: true,
        revocationState: 'pending',
      },
      $unset: { revocationFailureCode: 1 },
    },
  )

  const rounds = await HireRound.find({
    workspaceId,
    runtimePurgeRequested: true,
    runtimePurgedAt: { $exists: false },
  })
    .sort({ _id: 1 })
    .select('_id')
    .lean()
  for (let offset = 0; offset < rounds.length; offset += RUNTIME_PURGE_DELIVERY_BATCH_SIZE) {
    const outcomes = await Promise.all(
      rounds
        .slice(offset, offset + RUNTIME_PURGE_DELIVERY_BATCH_SIZE)
        .map((round) =>
          deliverRuntimeRevocation(workspaceId.toString(), round._id.toString()),
        ),
    )
    await renewWorkspacePurgeLease(workspaceId, claimToken, clock())
    if (outcomes.some((confirmed) => !confirmed)) {
      throw new Error('Isolated runtime personal-data purge is incomplete')
    }
  }
}

async function deleteWorkspaceGraphChildren(
  workspaceId: mongoose.Types.ObjectId,
  session: ClientSession,
  now: Date,
): Promise<HireAssessmentExportCleanupTarget[]> {
  // Auth artifacts first, then evidence/edge records, then tenancy parents.
  // Mongo does not permit parallel operations on a transaction session.
  await HireMemberSetup.deleteMany({ workspaceId }, { session })
  await HireMemberSession.deleteMany({ workspaceId }, { session })
  await HireGuestSession.deleteMany({ workspaceId }, { session })
  await HireConsentReceipt.deleteMany({ workspaceId }, { session })
  await HireEngineHandoff.deleteMany({ workspaceId }, { session })
  await HireEngineIngestionEvent.deleteMany({ workspaceId }, { session })
  await HireMultimodalObservationIngestionEvent.deleteMany(
    { workspaceId },
    { session },
  )
  await HireMultimodalObservation.deleteMany({ workspaceId }, { session })
  await HireMultimodalObservationPurgeObligation.deleteMany(
    { workspaceId },
    { session },
  )
  await HireMultimodalAnalysisIngestionEvent.deleteMany(
    { workspaceId },
    { session },
  )
  await HireMultimodalAnalysis.deleteMany({ workspaceId }, { session })
  await HireInterviewResult.deleteMany({ workspaceId }, { session })
  await HireInterviewAttempt.deleteMany({ workspaceId }, { session })
  await HireMediaAsset.deleteMany(
    {
      workspaceId,
      state: 'purged',
      purgedAt: { $exists: true },
      ingestionLeaseId: { $exists: false },
      ingestionLeaseExpiresAt: { $exists: false },
    },
    { session },
  )
  await HirePrivacyRequest.deleteMany({ workspaceId }, { session })
  await HireEmailOutbox.deleteMany({ workspaceId }, { session })
  // Member operational-mail rows include a private recipient snapshot. They
  // must precede both membership rows and the workspace root during purge.
  await HireDigestOutbox.deleteMany({ workspaceId }, { session })
  await HireDigestPreference.deleteMany({ workspaceId }, { session })
  await HireAiInviteDelivery.deleteMany({ workspaceId }, { session })
  // Human-round capabilities and delivery recovery material are control-plane
  // records only. Delete the egress/recovery edge before its kit, scorecard,
  // and round parents; unlike AI rounds, none of these records has a runtime
  // counterpart to revoke or await.
  await HireHumanKitDelivery.deleteMany({ workspaceId }, { session })
  await HireInterviewKit.deleteMany({ workspaceId }, { session })
  await HireHumanScorecard.deleteMany({ workspaceId }, { session })
  await HireHumanRound.deleteMany({ workspaceId }, { session })
  await HireRound.deleteMany({ workspaceId }, { session })
  // Intake tasks can still hold the original resume payload and supplied
  // contact details. Remove them before the candidate/application parents.
  await HireIntakeTask.deleteMany({ workspaceId }, { session })
  // A confirmed gate/batch holds only Hire-owned IDs and score snapshots,
  // but those immutable records must not outlive the workspace they scope.
  // Items first retain the application reservation, then their batch/gate.
  await HireInvitationBatchItem.deleteMany({ workspaceId }, { session })
  await HireInvitationBatch.deleteMany({ workspaceId }, { session })
  await HireScreeningGate.deleteMany({ workspaceId }, { session })
  const assessmentExportCleanupTargets = await cancelHireAssessmentExports({
    scope: { workspaceId },
    cancelledAt: now,
    session,
  })
  await HireAssessmentExport.deleteMany({ workspaceId }, { session })
  await cancelHireReportExportsForLifecycle({
    scope: { workspaceId },
    cancelledAt: now,
    session,
  })
  await HireReportExport.deleteMany({ workspaceId }, { session })
  // `HireReportExportCleanup` intentionally survives this graph deletion. Its
  // immutable, deletion-only tombstone is the recovery coordinate for a late
  // upload that races the final hard-purge transaction.
  // Decision edges precede their application/candidate parents. An external
  // verdict references a packet, and a packet carries immutable candidate
  // snapshots, so purge verdicts before packets and both before Hire records.
  await HireExternalVerdict.deleteMany({ workspaceId }, { session })
  await HireSharePacket.deleteMany({ workspaceId }, { session })
  await HireCandidateStatusLink.deleteMany({ workspaceId }, { session })
  await HireApplication.deleteMany({ workspaceId }, { session })
  await HireCandidate.deleteMany({ workspaceId }, { session })
  await HireJobRequirementVersion.deleteMany({ workspaceId }, { session })
  await HireJob.deleteMany({ workspaceId }, { session })
  // Jobs are the only department-owned graph parent. Remove catalog rows
  // after every job reference is gone, before the workspace tenancy root.
  await HireDepartment.deleteMany({ workspaceId }, { session })
  // The marker is last among the synthetic graph parents. It remains an
  // aggregate-exclusion/recovery coordinate until every child is gone.
  await HireOnboardingTestDrive.deleteMany({ workspaceId }, { session })
  await HireWorkspaceMember.deleteMany({ workspaceId }, { session })
  return assessmentExportCleanupTargets
}

async function deleteClaimedWorkspaceGraph(
  workspaceId: mongoose.Types.ObjectId,
  claimToken: string,
  now: Date,
): Promise<void> {
  const session = await mongoose.startSession()
  let assessmentExportCleanupTargets: HireAssessmentExportCleanupTarget[] = []
  try {
    await session.withTransaction(async () => {
      const claimed = await HireWorkspace.exists({
        _id: workspaceId,
        lifecycleState: 'deletion_pending',
        purgeAfter: { $lte: now },
        purgeState: 'claimed',
        purgeClaimToken: claimToken,
      }).session(session)
      if (!claimed) throw new Error('Workspace purge claim is no longer authoritative')

      const unacknowledgedMedia = await HireMediaAsset.exists({
        workspaceId,
        $or: [
          { state: { $ne: 'purged' } },
          { purgedAt: { $exists: false } },
          { ingestionLeaseId: { $exists: true } },
          { ingestionLeaseExpiresAt: { $exists: true } },
        ],
      }).session(session)
      if (unacknowledgedMedia) {
        throw new Error('Workspace media deletion has not been acknowledged')
      }

      // Every round was upgraded to a personal-data purge tombstone before
      // this transaction. Preserve all retry coordinates until the isolated
      // runtime has acknowledged each exact workspace/application/round.
      const runtimeWorkPending = await HireRound.exists({
        workspaceId,
        runtimePurgedAt: { $exists: false },
      }).session(session)
      if (runtimeWorkPending) {
        throw new Error('Isolated runtime personal-data purge is still pending')
      }

      assessmentExportCleanupTargets = await deleteWorkspaceGraphChildren(workspaceId, session, now)
      const removed = await HireWorkspace.deleteOne(
        {
          _id: workspaceId,
          lifecycleState: 'deletion_pending',
          purgeAfter: { $lte: now },
          purgeState: 'claimed',
          purgeClaimToken: claimToken,
        },
        { session },
      )
      if (removed.deletedCount !== 1) {
        throw new Error('Workspace purge claim changed before root deletion')
      }
    })
    await deleteHireAssessmentExportObjects(assessmentExportCleanupTargets)
  } finally {
    await session.endSession()
  }
}

export async function purgeDueHireWorkspaces(input: {
  workspaceId: string
  now?: Date
  storage?: HireMediaStoragePort
  brandingStorage?: HireWorkspaceBrandingStoragePort
  clock?: () => Date
}): Promise<HireWorkspacePurgeReport> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const storage = input.storage ?? hireMediaStorage
  const brandingStorage = input.brandingStorage ?? hireWorkspaceBrandingStorage
  const clock = input.clock ?? (() => new Date())
  const due = await HireWorkspace.find({
    _id: workspaceId,
    lifecycleState: 'deletion_pending',
    purgeAfter: { $lte: now },
  })
    .sort({ purgeAfter: 1, _id: 1 })
    .limit(1)
    .select('_id')

  let claimed = 0
  let purged = 0
  let failed = 0
  let mediaObjectsDeleted = 0
  for (const dueWorkspace of due) {
    const claim = await claimWorkspaceForPurge(dueWorkspace._id, now)
    if (!claim) {
      // A live lease means a previous execution may still own the graph. Do
      // not report success: the Inngest step must retry until that execution
      // finishes or the durable lease expires.
      failed += 1
      continue
    }
    claimed += 1
    try {
      await requestAndConfirmWorkspaceRuntimePurge(
        claim.workspace._id,
        claim.claimToken,
        now,
        clock,
      )
      mediaObjectsDeleted += await deleteWorkspaceMedia(
        claim.workspace._id,
        claim.claimToken,
        storage,
        clock,
      )
      await deleteWorkspaceLogo(claim.workspace._id, brandingStorage)
      await renewWorkspacePurgeLease(claim.workspace._id, claim.claimToken, clock())
      await deleteClaimedWorkspaceGraph(claim.workspace._id, claim.claimToken, now)
      purged += 1
    } catch (error) {
      failed += 1
      await releaseFailedWorkspacePurge(
        claim.workspace._id,
        claim.claimToken,
        error,
      )
    }
  }

  return {
    scanned: due.length,
    claimed,
    purged,
    failed,
    mediaObjectsDeleted,
  }
}

export const __workspacePurge = {
  MEDIA_DELETE_BATCH_SIZE,
  RUNTIME_PURGE_DELIVERY_BATCH_SIZE,
  PURGE_LEASE_MS,
  LEGACY_STAGING_GRACE_MS,
  STALE_MEDIA_PURGE_CLAIM_MS,
  mediaCoordinate,
  stagingWriterStillOwns,
  deleteWorkspaceLogo,
  purgeFailureMessage,
}
