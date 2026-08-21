import mongoose, { type ClientSession } from 'mongoose'
import {
  HireApplication,
  HireJob,
  HireMediaAsset,
  HirePrivacyRequest,
  HireRound,
  activeHirePrivacyRequestFilter,
  claimHireCandidatePiiWriteFence,
  connectHireControlDB,
  HireCandidatePiiTombstoneError,
} from '@hire'
import { AppError, NotFoundError } from '@shared/errors'
import { aiLogger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import { withActiveHireWorkspaceWriteTransaction } from '@hire-multimodal-boundary'
import {
  HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS,
  HireMultimodalAnalysis,
} from '../models'

type ManualRecoveryOutcome = 'requeued' | 'already_queued'

export interface HireMultimodalAnalysisRecoveryResult {
  outcome: ManualRecoveryOutcome
  dispatch: 'sent' | 'recovery_pending'
}

interface RecoveryAnalysis {
  _id: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  landmarksAssetId: mongoose.Types.ObjectId
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'stale'
  retryAttemptCount?: number
  purgeEligibleAt?: Date
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID')
  }
  return new mongoose.Types.ObjectId(value)
}

async function assertRecoveryInputsAvailable(input: {
  analysis: RecoveryAnalysis
  workspaceId: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<void> {
  const { analysis, workspaceId, now, session } = input
  await claimHireCandidatePiiWriteFence({
    workspaceId,
    candidateId: analysis.candidateId,
    session,
  })

  // MongoDB transaction sessions do not support parallel operations. Keep
  // every authority/read fence sequential on this one snapshot.
  const latest = await HireMultimodalAnalysis.findOne({
    workspaceId,
    applicationId: analysis.applicationId,
    roundId: analysis.roundId,
  })
    .sort({ capturedAt: -1, createdAt: -1, _id: -1 })
    .select('_id')
    .session(session)
    .lean()
  const application = await HireApplication.exists({
    _id: analysis.applicationId,
    workspaceId,
    jobId: analysis.jobId,
    candidateId: analysis.candidateId,
  }).session(session)
  const job = await HireJob.exists({ _id: analysis.jobId, workspaceId }).session(session)
  const round = await HireRound.exists({
    _id: analysis.roundId,
    workspaceId,
    applicationId: analysis.applicationId,
    jobId: analysis.jobId,
    candidateId: analysis.candidateId,
  }).session(session)
  const asset = await HireMediaAsset.exists({
    _id: analysis.landmarksAssetId,
    workspaceId,
    applicationId: analysis.applicationId,
    jobId: analysis.jobId,
    candidateId: analysis.candidateId,
    roundId: analysis.roundId,
    attemptId: analysis.attemptId,
    kind: 'facial_landmarks',
    state: 'ready',
    active: true,
    $or: [
      { purgeEligibleAt: { $exists: false } },
      { purgeEligibleAt: { $gt: now } },
    ],
  }).session(session)
  const privacy = await HirePrivacyRequest.exists({
    workspaceId,
    candidateId: analysis.candidateId,
    ...activeHirePrivacyRequestFilter(now),
  }).session(session)
  if (privacy) {
    throw new AppError(
      'Candidate privacy deletion is in progress',
      410,
      'HIRE_CANDIDATE_PRIVACY_PENDING',
    )
  }
  if (!latest || latest._id.toString() !== analysis._id.toString()) {
    throw new AppError(
      'A newer analysis superseded this report',
      409,
      'HIRE_MULTIMODAL_ANALYSIS_NOT_CURRENT',
    )
  }
  if (!application || !job || !round || !asset) {
    throw new AppError(
      'The analysis inputs are no longer available',
      410,
      'HIRE_MULTIMODAL_ANALYSIS_INPUT_UNAVAILABLE',
    )
  }
}

/**
 * Explicitly requeue one exhausted recruiter report without creating a new
 * analysis row. Workspace/member, candidate privacy, lifecycle, and raw-asset
 * authority are all rechecked in the same transaction as the state change.
 */
export async function retryFailedHireMultimodalAnalysis(input: {
  workspaceId: string
  authorityMemberId: string
  applicationId: string
  analysisId: string
  now?: Date
}): Promise<HireMultimodalAnalysisRecoveryResult> {
  await connectHireControlDB()
  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const authorityMemberId = objectId(input.authorityMemberId, 'member id')
  const applicationId = objectId(input.applicationId, 'application id')
  const analysisId = objectId(input.analysisId, 'analysis id')
  const now = input.now ?? new Date()

  let outcome: ManualRecoveryOutcome
  try {
    outcome = await withActiveHireWorkspaceWriteTransaction(
      workspaceId,
      authorityMemberId,
      async (session) => {
        const analysis = await HireMultimodalAnalysis.findOne({
          _id: analysisId,
          workspaceId,
          applicationId,
        })
          .select(
            '_id applicationId jobId candidateId roundId attemptId landmarksAssetId status retryAttemptCount purgeEligibleAt',
          )
          .session(session)
          .lean() as RecoveryAnalysis | null
        if (!analysis) throw new NotFoundError('Interview analysis')
        if (
          analysis.purgeEligibleAt &&
          analysis.purgeEligibleAt.getTime() <= now.getTime()
        ) {
          throw new AppError(
            'The analysis retention period has ended',
            410,
            'HIRE_MULTIMODAL_ANALYSIS_EXPIRED',
          )
        }

        await assertRecoveryInputsAvailable({ analysis, workspaceId, now, session })
        if (analysis.status === 'pending' || analysis.status === 'processing') {
          return 'already_queued'
        }
        if (
          analysis.status !== 'failed' ||
          (analysis.retryAttemptCount ?? 0) <
            HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS
        ) {
          throw new AppError(
            'This analysis is not eligible for a manual retry',
            409,
            'HIRE_MULTIMODAL_ANALYSIS_NOT_RETRYABLE',
          )
        }

        const requeued = await HireMultimodalAnalysis.updateOne(
          {
            _id: analysis._id,
            workspaceId,
            applicationId,
            status: 'failed',
            retryAttemptCount: {
              $gte: HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS,
            },
          },
          {
            $set: { status: 'pending', retryAttemptCount: 0 },
            $unset: {
              retryAt: 1,
              errorCode: 1,
              processingLeaseExpiresAt: 1,
              completedAt: 1,
            },
          },
          { session },
        )
        if (requeued.matchedCount === 1) return 'requeued'

        const current = await HireMultimodalAnalysis.findOne({
          _id: analysis._id,
          workspaceId,
          applicationId,
        }).select('status').session(session).lean()
        if (current?.status === 'pending' || current?.status === 'processing') {
          return 'already_queued'
        }
        throw new AppError(
          'The analysis state changed before it could be retried',
          409,
          'HIRE_MULTIMODAL_ANALYSIS_RETRY_CONFLICT',
        )
      },
    )
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new AppError(
        'Candidate personal data is unavailable',
        410,
        'HIRE_CANDIDATE_PII_TOMBSTONED',
      )
    }
    throw error
  }

  let dispatch: HireMultimodalAnalysisRecoveryResult['dispatch'] = 'sent'
  try {
    await inngest.send({
      name: 'hire/multimodal-analysis.requested',
      data: {
        workspaceId: workspaceId.toString(),
        analysisId: analysisId.toString(),
      },
    })
  } catch {
    dispatch = 'recovery_pending'
    aiLogger.warn(
      { workspaceId: workspaceId.toString(), analysisId: analysisId.toString() },
      'hire: multimodal analysis retry dispatch failed; recovery sweep will retry',
    )
  }
  return { outcome, dispatch }
}
