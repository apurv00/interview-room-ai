import mongoose from 'mongoose'
import { HireMediaAsset, type IHireMediaAsset } from '../models/HireMediaAsset'
import { HireJob } from '../models/HireJob'
import { HirePrivacyRequest } from '../models/HirePrivacyRequest'
import { HireRound } from '../models/HireRound'
import {
  HireMultimodalAnalysis,
  HireMultimodalObservation,
  HireMultimodalObservationPurgeObligation,
} from '../../hire-multimodal/models'
import {
  cancelFutureHireMultimodalObservationRetention,
  purgeDueHireMultimodalObservationRetention,
  scheduleHireMultimodalObservationRetention,
} from '../../hire-multimodal/services/observationRetentionService'
import { HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION } from '@shared/contracts/hireMultimodalObservationBridge'
import { HIRE_AI_CONSENT_VERSION } from '@hire/policies/aiInterviewConsent'
import { connectHireControlDB } from './hireControlBoundary'
import {
  hireMediaStorage,
  type HireMediaCoordinate,
  type HireMediaStoragePort,
} from './hireMediaStorage'

const DEFAULT_PURGE_BATCH_SIZE = 100
const STALE_STAGING_MS = 60 * 60 * 1000
const STALE_PURGE_CLAIM_MS = 15 * 60 * 1000

export interface HireMediaPurgeReport {
  scanned: number
  purged: number
  failed: number
  observationsPurged: number
  runtimeObservationPurgeFailed: number
  privacyRequestsCompleted: number
}

/** Calendar-month arithmetic with end-of-month clamping (Jan 31 + 1 month = Feb 28/29). */
export function addCalendarMonths(date: Date, months: number): Date {
  const target = new Date(date.getTime())
  const day = target.getUTCDate()
  target.setUTCDate(1)
  target.setUTCMonth(target.getUTCMonth() + months)
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target
}

export interface HireClosedJobMediaReconciliationReport {
  closedJobs: number
  scheduled: number
  scheduledMedia: number
  scheduledObservations: number
  scheduledRuntimePurgeObligations: number
}

/**
 * Reconciles the crash window between the close transaction and its
 * best-effort post-commit scheduler call. The root and every joined child are
 * scoped to one workspace; reruns are idempotent because only media and
 * supplemental observations without a purge deadline are selected and updated.
 */
export async function reconcileClosedJobMediaRetention(input: {
  workspaceId: string
  batchSize?: number
}): Promise<HireClosedJobMediaReconciliationReport> {
  await connectHireControlDB()
  const workspaceId = new mongoose.Types.ObjectId(input.workspaceId)
  const batchSize = Math.min(Math.max(input.batchSize ?? DEFAULT_PURGE_BATCH_SIZE, 1), 500)
  const closedJobs = await HireJob.aggregate<{
    _id: mongoose.Types.ObjectId
    closedAt: Date
  }>([
    {
      $match: {
        workspaceId,
        status: 'closed',
        closedAt: { $type: 'date' },
      },
    },
    {
      $lookup: {
        from: HireMediaAsset.collection.name,
        let: { jobId: '$_id', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$jobId', '$$jobId'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
              state: { $nin: ['purged', 'purge_claimed'] },
              purgeEligibleAt: { $exists: false },
              $or: [
                { purgeReason: { $exists: false } },
                { purgeReason: 'job_closed' },
              ],
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'unscheduledMedia',
      },
    },
    {
      $lookup: {
        from: HireMultimodalObservation.collection.name,
        let: { jobId: '$_id', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$jobId', '$$jobId'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
              purgeEligibleAt: { $exists: false },
              $or: [
                { purgeReason: { $exists: false } },
                { purgeReason: 'job_closed' },
              ],
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'unscheduledObservations',
      },
    },
    {
      $lookup: {
        from: HireMultimodalAnalysis.collection.name,
        let: { jobId: '$_id', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$jobId', '$$jobId'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
              purgeEligibleAt: { $exists: false },
              $or: [
                { purgeReason: { $exists: false } },
                { purgeReason: 'job_closed' },
              ],
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'unscheduledAnalyses',
      },
    },
    {
      $lookup: {
        from: HireRound.collection.name,
        let: { jobId: '$_id', workspaceId: '$workspaceId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$jobId', '$$jobId'] },
                  { $eq: ['$workspaceId', '$$workspaceId'] },
                ],
              },
              kind: 'ai',
              consentVersion: {
                $in: [
                  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
                  HIRE_AI_CONSENT_VERSION,
                ],
              },
            },
          },
          {
            $lookup: {
              from: HireMultimodalObservationPurgeObligation.collection.name,
              let: { roundId: '$_id', workspaceId: '$workspaceId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$roundId', '$$roundId'] },
                        { $eq: ['$workspaceId', '$$workspaceId'] },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: 'existingRuntimePurgeObligation',
            },
          },
          { $match: { 'existingRuntimePurgeObligation.0': { $exists: false } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'unscheduledRuntimeObservationPurge',
      },
    },
    {
      $match: {
        $or: [
          { 'unscheduledMedia.0': { $exists: true } },
          { 'unscheduledObservations.0': { $exists: true } },
          { 'unscheduledAnalyses.0': { $exists: true } },
          { 'unscheduledRuntimeObservationPurge.0': { $exists: true } },
        ],
      },
    },
    { $sort: { closedAt: 1, _id: 1 } },
    { $limit: batchSize },
    { $project: { _id: 1, closedAt: 1 } },
  ])

  let scheduledMedia = 0
  let scheduledObservations = 0
  let scheduledRuntimePurgeObligations = 0
  for (const job of closedJobs) {
    const purgeEligibleAt = addCalendarMonths(job.closedAt, 6)
    const [media, observations] = await Promise.all([
      HireMediaAsset.updateMany(
        {
          workspaceId,
          jobId: job._id,
          state: { $nin: ['purged', 'purge_claimed'] },
          purgeEligibleAt: { $exists: false },
          $or: [
            { purgeReason: { $exists: false } },
            { purgeReason: 'job_closed' },
          ],
        },
        { $set: { purgeEligibleAt, purgeReason: 'job_closed' } },
      ),
      scheduleHireMultimodalObservationRetention({
        workspaceId,
        jobId: job._id,
        purgeEligibleAt,
      }),
    ])
    scheduledMedia += media.modifiedCount ?? 0
    scheduledObservations += observations.scheduledObservations
    scheduledRuntimePurgeObligations += observations.scheduledRuntimePurgeObligations
  }
  return {
    closedJobs: closedJobs.length,
    scheduled: scheduledMedia + scheduledObservations + scheduledRuntimePurgeObligations,
    scheduledMedia,
    scheduledObservations,
    scheduledRuntimePurgeObligations,
  }
}

export async function scheduleHireJobMediaPurge(input: {
  workspaceId: string
  jobId: string
  closedAt: Date
}): Promise<{
  purgeEligibleAt: Date
  scheduled: number
  scheduledMedia: number
  scheduledObservations: number
  scheduledRuntimePurgeObligations: number
}> {
  await connectHireControlDB()
  const purgeEligibleAt = addCalendarMonths(input.closedAt, 6)
  const [media, observations] = await Promise.all([
    HireMediaAsset.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        state: { $nin: ['purged', 'purge_claimed'] },
        $or: [
          { purgeReason: { $exists: false } },
          { purgeReason: 'job_closed' },
        ],
      },
      { $set: { purgeEligibleAt, purgeReason: 'job_closed' } },
    ),
    scheduleHireMultimodalObservationRetention({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      purgeEligibleAt,
    }),
  ])
  const scheduledMedia = media.modifiedCount ?? 0
  const scheduledObservations = observations.scheduledObservations
  const scheduledRuntimePurgeObligations = observations.scheduledRuntimePurgeObligations
  return {
    purgeEligibleAt,
    scheduled: scheduledMedia + scheduledObservations + scheduledRuntimePurgeObligations,
    scheduledMedia,
    scheduledObservations,
    scheduledRuntimePurgeObligations,
  }
}

export async function cancelFutureHireJobMediaPurge(input: {
  workspaceId: string
  jobId: string
  reopenedAt?: Date
}): Promise<number> {
  await connectHireControlDB()
  const reopenedAt = input.reopenedAt ?? new Date()
  const [media, observations] = await Promise.all([
    HireMediaAsset.updateMany(
      {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        state: { $in: ['ready', 'purge_failed', 'staging'] },
        purgeReason: 'job_closed',
        purgeEligibleAt: { $gt: reopenedAt },
      },
      {
        $unset: {
          purgeEligibleAt: 1,
          purgeReason: 1,
          purgeClaimedAt: 1,
          purgeFailureCode: 1,
        },
        $set: { state: 'ready' },
      },
    ),
    cancelFutureHireMultimodalObservationRetention({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      reopenedAt,
    }),
  ])
  return (media.modifiedCount ?? 0) + observations
}

function coordinate(asset: IHireMediaAsset): HireMediaCoordinate {
  return {
    workspaceId: asset.workspaceId.toString(),
    applicationId: asset.applicationId.toString(),
    roundId: asset.roundId.toString(),
    attemptId: asset.attemptId.toString(),
    assetId: asset._id.toString(),
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 160)
  return 'MEDIA_DELETE_FAILED'
}

async function completeSatisfiedPrivacyRequests(workspaceId: string): Promise<number> {
  const requests = await HirePrivacyRequest.find({
    workspaceId,
    status: 'processing',
    live: true,
  })
    .select('_id workspaceId candidateId')
    .limit(DEFAULT_PURGE_BATCH_SIZE)
  let completed = 0
  for (const request of requests) {
    const remaining = await HireMediaAsset.exists({
      workspaceId,
      candidateId: request.candidateId,
      state: { $ne: 'purged' },
    })
    if (remaining) continue
    const runtimePurgePending = await HireRound.exists({
      workspaceId,
      candidateId: request.candidateId,
      runtimePurgeRequested: true,
      runtimePurgedAt: { $exists: false },
    })
    if (runtimePurgePending) continue
    const result = await HirePrivacyRequest.updateOne(
      {
        _id: request._id,
        workspaceId,
        candidateId: request.candidateId,
        status: 'processing',
        live: true,
      },
      {
        $set: { status: 'completed', completedAt: new Date() },
        $unset: { live: 1 },
      },
    )
    completed += result.modifiedCount ?? 0
  }
  return completed
}

export async function markStaleHireMediaForPurge(input: {
  workspaceId: string
  now?: Date
}): Promise<number> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const result = await HireMediaAsset.updateMany(
    {
      workspaceId: input.workspaceId,
      state: 'staging',
      createdAt: { $lte: new Date(now.getTime() - STALE_STAGING_MS) },
      purgeEligibleAt: { $exists: false },
    },
    {
      $set: {
        purgeEligibleAt: now,
        purgeReason: 'stale_staging',
      },
    },
  )
  return result.modifiedCount ?? 0
}

async function recoverStaleHireMediaPurgeClaims(input: {
  workspaceId: string
  now: Date
}): Promise<number> {
  const result = await HireMediaAsset.updateMany(
    {
      workspaceId: input.workspaceId,
      state: 'purge_claimed',
      purgeClaimedAt: {
        $lte: new Date(input.now.getTime() - STALE_PURGE_CLAIM_MS),
      },
    },
    {
      $set: {
        state: 'purge_failed',
        purgeFailureCode: 'STALE_PURGE_CLAIM',
      },
      $unset: { purgeClaimedAt: 1, active: 1 },
    },
  )
  return result.modifiedCount ?? 0
}

export async function purgeDueHireMedia(input: {
  workspaceId: string
  now?: Date
  batchSize?: number
  storage?: HireMediaStoragePort
}): Promise<HireMediaPurgeReport> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const batchSize = Math.min(Math.max(input.batchSize ?? DEFAULT_PURGE_BATCH_SIZE, 1), 500)
  const storage = input.storage ?? hireMediaStorage
  await markStaleHireMediaForPurge({ workspaceId: input.workspaceId, now })
  await recoverStaleHireMediaPurgeClaims({ workspaceId: input.workspaceId, now })
  // Install/acknowledge the runtime retention tombstone before deleting the
  // control copy of an analysis artifact. Otherwise a crash after control R2
  // deletion could leave a pending runtime outbox free to republish data that
  // has already reached its closed-job deadline.
  const observationRetention = await purgeDueHireMultimodalObservationRetention({
    workspaceId: input.workspaceId,
    now,
    batchSize,
  })
  if (observationRetention.failed > 0) {
    return {
      scanned: 0,
      purged: 0,
      failed: observationRetention.failed,
      observationsPurged: observationRetention.controlPurged,
      runtimeObservationPurgeFailed: observationRetention.failed,
      privacyRequestsCompleted: await completeSatisfiedPrivacyRequests(input.workspaceId),
    }
  }
  const due = await HireMediaAsset.find({
    workspaceId: input.workspaceId,
    state: { $in: ['ready', 'purge_failed', 'staging'] },
    purgeEligibleAt: { $lte: now },
  })
    .sort({ purgeEligibleAt: 1, _id: 1 })
    .limit(batchSize)

  let purged = 0
  let failed = 0
  for (const candidate of due) {
    const asset = await HireMediaAsset.findOneAndUpdate(
      {
        _id: candidate._id,
        workspaceId: input.workspaceId,
        applicationId: candidate.applicationId,
        jobId: candidate.jobId,
        candidateId: candidate.candidateId,
        roundId: candidate.roundId,
        attemptId: candidate.attemptId,
        objectKey: candidate.objectKey,
        state: { $in: ['ready', 'purge_failed', 'staging'] },
        purgeEligibleAt: { $lte: now },
      },
      {
        $set: { state: 'purge_claimed', purgeClaimedAt: now },
        $unset: { active: 1, purgeFailureCode: 1 },
      },
      { new: true },
    )
    if (!asset) continue
    try {
      await storage.delete({ key: asset.objectKey, coordinate: coordinate(asset) })
      const result = await HireMediaAsset.updateOne(
        {
          _id: asset._id,
          workspaceId: input.workspaceId,
          applicationId: asset.applicationId,
          roundId: asset.roundId,
          attemptId: asset.attemptId,
          objectKey: asset.objectKey,
          state: 'purge_claimed',
        },
        {
          $set: { state: 'purged', purgedAt: now },
          $unset: { purgeClaimedAt: 1, purgeFailureCode: 1, active: 1 },
        },
      )
      purged += result.modifiedCount ?? 0
    } catch (error) {
      failed++
      await HireMediaAsset.updateOne(
        {
          _id: asset._id,
          workspaceId: input.workspaceId,
          applicationId: asset.applicationId,
          roundId: asset.roundId,
          attemptId: asset.attemptId,
          state: 'purge_claimed',
        },
        {
          $set: {
            state: 'purge_failed',
            purgeFailureCode: failureCode(error),
          },
          $unset: { purgeClaimedAt: 1, active: 1 },
        },
      )
    }
  }

  return {
    scanned: due.length,
    purged,
    failed: failed + observationRetention.failed,
    observationsPurged: observationRetention.controlPurged,
    runtimeObservationPurgeFailed: observationRetention.failed,
    privacyRequestsCompleted: await completeSatisfiedPrivacyRequests(input.workspaceId),
  }
}

export const __mediaLifecycle = {
  STALE_STAGING_MS,
  STALE_PURGE_CLAIM_MS,
  coordinate,
}
