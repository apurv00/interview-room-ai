import mongoose from 'mongoose'
import { HireMediaAsset, type IHireMediaAsset } from '../models/HireMediaAsset'
import { HireJob } from '../models/HireJob'
import { HirePrivacyRequest } from '../models/HirePrivacyRequest'
import { HireRound } from '../models/HireRound'
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
}

/**
 * Reconciles the crash window between the close transaction and its
 * best-effort post-commit scheduler call. The root and every joined child are
 * scoped to one workspace; reruns are idempotent because only media without a
 * purge deadline are selected and updated.
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
    { $match: { 'unscheduledMedia.0': { $exists: true } } },
    { $sort: { closedAt: 1, _id: 1 } },
    { $limit: batchSize },
    { $project: { _id: 1, closedAt: 1 } },
  ])

  let scheduled = 0
  for (const job of closedJobs) {
    const purgeEligibleAt = addCalendarMonths(job.closedAt, 6)
    const result = await HireMediaAsset.updateMany(
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
    )
    scheduled += result.modifiedCount ?? 0
  }
  return { closedJobs: closedJobs.length, scheduled }
}

export async function scheduleHireJobMediaPurge(input: {
  workspaceId: string
  jobId: string
  closedAt: Date
}): Promise<{ purgeEligibleAt: Date; scheduled: number }> {
  await connectHireControlDB()
  const purgeEligibleAt = addCalendarMonths(input.closedAt, 6)
  const result = await HireMediaAsset.updateMany(
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
  )
  return { purgeEligibleAt, scheduled: result.modifiedCount ?? 0 }
}

export async function cancelFutureHireJobMediaPurge(input: {
  workspaceId: string
  jobId: string
  reopenedAt?: Date
}): Promise<number> {
  await connectHireControlDB()
  const reopenedAt = input.reopenedAt ?? new Date()
  const result = await HireMediaAsset.updateMany(
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
  )
  return result.modifiedCount ?? 0
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
    failed,
    privacyRequestsCompleted: await completeSatisfiedPrivacyRequests(input.workspaceId),
  }
}

export const __mediaLifecycle = {
  STALE_STAGING_MS,
  STALE_PURGE_CLAIM_MS,
  coordinate,
}
