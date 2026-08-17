import mongoose from 'mongoose'
import { HireMediaAsset } from '../models/HireMediaAsset'
import { connectHireControlDB } from './hireControlBoundary'
import {
  HIRE_MEDIA_DOWNLOAD_TTL_SECONDS,
  hireMediaStorage,
  type HireMediaStoragePort,
} from './hireMediaStorage'

export class HireMediaAccessError extends Error {
  readonly code = 'MEDIA_NOT_FOUND'
  readonly status = 404

  constructor() {
    super('Media not found')
    this.name = 'HireMediaAccessError'
  }
}

function availableAt(now: Date): Record<string, unknown> {
  return {
    state: 'ready',
    active: true,
    $or: [
      { purgeEligibleAt: { $exists: false } },
      { purgeEligibleAt: { $gt: now } },
    ],
  }
}

export async function createHireMediaDownloadCapability(input: {
  workspaceId: string
  applicationId: string
  assetId: string
  now?: Date
  storage?: HireMediaStoragePort
}): Promise<{ url: string; expiresInSeconds: number; kind: string }> {
  if (
    !mongoose.Types.ObjectId.isValid(input.workspaceId) ||
    !mongoose.Types.ObjectId.isValid(input.applicationId) ||
    !mongoose.Types.ObjectId.isValid(input.assetId)
  ) {
    throw new HireMediaAccessError()
  }
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const storage = input.storage ?? hireMediaStorage
  const asset = await HireMediaAsset.findOne({
    _id: input.assetId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    // Landmark vectors are retained as a private analysis input, never as a
    // recruiter-downloadable media object. The reviewer receives derived
    // report/timeline data and the recorded video through separate assets.
    kind: { $ne: 'facial_landmarks' },
    ...availableAt(now),
  }).lean()
  if (!asset) throw new HireMediaAccessError()

  const url = await storage.signDownload({
    key: asset.objectKey,
    expiresInSeconds: HIRE_MEDIA_DOWNLOAD_TTL_SECONDS,
  })

  // Signing is asynchronous. Re-read the complete Hire coordinate so a
  // retention/privacy claim that won during signing withholds the capability.
  const stillAuthorized = await HireMediaAsset.exists({
    _id: asset._id,
    workspaceId: asset.workspaceId,
    applicationId: asset.applicationId,
    jobId: asset.jobId,
    candidateId: asset.candidateId,
    roundId: asset.roundId,
    attemptId: asset.attemptId,
    objectKey: asset.objectKey,
    kind: { $ne: 'facial_landmarks' },
    ...availableAt(now),
  })
  if (!stillAuthorized) throw new HireMediaAccessError()

  return {
    url,
    expiresInSeconds: HIRE_MEDIA_DOWNLOAD_TTL_SECONDS,
    kind: asset.kind,
  }
}
