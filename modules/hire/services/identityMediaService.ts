import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { HireConsentReceipt } from '../models/HireConsentReceipt'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireJob } from '../models/HireJob'
import { HireMediaAsset, type IHireMediaAsset } from '../models/HireMediaAsset'
import { HireRound } from '../models/HireRound'
import { HireWorkspace } from '../models/HireWorkspace'
import {
  type HireConsentSnapshot,
  isRecognizedHireConsentSnapshot,
} from '../policies/aiInterviewConsent'
import { connectHireControlDB } from './hireControlBoundary'
import {
  hireMediaKey,
  hireMediaStorage,
  type HireMediaStoragePort,
} from './hireMediaStorage'
import type { HireGuestScope } from './identityConsentService'
import { addCalendarMonths } from './mediaLifecycleService'

export const MAX_IDENTITY_PHOTO_INPUT_BYTES = 3 * 1024 * 1024
export const MAX_IDENTITY_PHOTO_EDGE = 1280

export class HireIdentityMediaError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PHOTO_REQUIRED'
      | 'PHOTO_TOO_LARGE'
      | 'PHOTO_TYPE_INVALID'
      | 'CONSENT_REQUIRED'
      | 'ATTEMPT_INVALID'
      | 'ROUND_INVALID',
    readonly status: number,
  ) {
    super(message)
    this.name = 'HireIdentityMediaError'
  }
}

export interface NormalizedIdentityPhoto {
  body: Buffer
  contentType: 'image/jpeg'
  sha256: string
  width: number
  height: number
}

export async function normalizeIdentityPhoto(input: {
  body: Buffer
  declaredContentType?: string
}): Promise<NormalizedIdentityPhoto> {
  if (input.body.byteLength === 0) {
    throw new HireIdentityMediaError('A captured photo is required', 'PHOTO_REQUIRED', 400)
  }
  if (input.body.byteLength > MAX_IDENTITY_PHOTO_INPUT_BYTES) {
    throw new HireIdentityMediaError(
      'The captured photo is too large',
      'PHOTO_TOO_LARGE',
      413,
    )
  }
  if (
    input.declaredContentType &&
    !['image/jpeg', 'image/png'].includes(input.declaredContentType.toLowerCase())
  ) {
    throw new HireIdentityMediaError(
      'Only a live JPEG or PNG camera capture is accepted',
      'PHOTO_TYPE_INVALID',
      415,
    )
  }

  try {
    const source = sharp(input.body, {
      failOn: 'warning',
      limitInputPixels: 20_000_000,
      sequentialRead: true,
    })
    const metadata = await source.metadata()
    if (!metadata.format || !['jpeg', 'png'].includes(metadata.format)) {
      throw new HireIdentityMediaError(
        'Only a live JPEG or PNG camera capture is accepted',
        'PHOTO_TYPE_INVALID',
        415,
      )
    }
    const body = await source
      .rotate()
      .resize({
        width: MAX_IDENTITY_PHOTO_EDGE,
        height: MAX_IDENTITY_PHOTO_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()
    const normalizedMetadata = await sharp(body).metadata()
    if (!normalizedMetadata.width || !normalizedMetadata.height) {
      throw new Error('Normalized image has no dimensions')
    }
    return {
      body,
      contentType: 'image/jpeg',
      sha256: createHash('sha256').update(body).digest('hex'),
      width: normalizedMetadata.width,
      height: normalizedMetadata.height,
    }
  } catch (error) {
    if (error instanceof HireIdentityMediaError) throw error
    throw new HireIdentityMediaError(
      'The camera capture is not a valid image',
      'PHOTO_TYPE_INVALID',
      415,
    )
  }
}

function scopedAttemptFilter(scope: HireGuestScope): Record<string, unknown> {
  return {
    _id: scope.attemptId,
    workspaceId: scope.workspaceId,
    applicationId: scope.applicationId,
    jobId: scope.jobId,
    candidateId: scope.candidateId,
    roundId: scope.roundId,
    live: true,
  }
}

interface HireAttemptConsent extends HireConsentSnapshot {
  acceptedAt: Date
}

/**
 * A live attempt remains bound to the receipt it was created with. This
 * explicitly recognizes the exact pre-rollout v2 version+digest pair so an
 * already-consented candidate can finish, while all new attempts receive v3
 * from identityConsentService.
 */
async function resolveAttemptConsent(
  scope: HireGuestScope,
  consentReceiptId: mongoose.Types.ObjectId,
): Promise<HireAttemptConsent | null> {
  const receipt = await HireConsentReceipt.findOne({
    _id: consentReceiptId,
    workspaceId: scope.workspaceId,
    applicationId: scope.applicationId,
    jobId: scope.jobId,
    candidateId: scope.candidateId,
    roundId: scope.roundId,
    attemptId: scope.attemptId,
    'accepted.recording': true,
    'accepted.identityPhoto': true,
    'accepted.attentionMonitoring': true,
    'accepted.aiEvaluation': true,
  })
    .select('consentVersion disclosureDigest acceptedAt')
    .lean<
      (Pick<HireConsentSnapshot, 'consentVersion' | 'disclosureDigest'> & {
        acceptedAt?: Date
      }) | null
    >()
  if (!isRecognizedHireConsentSnapshot(receipt) || !receipt.acceptedAt) return null
  return {
    consentVersion: receipt.consentVersion,
    disclosureDigest: receipt.disclosureDigest,
    acceptedAt: receipt.acceptedAt,
  }
}

export async function saveHireIdentityPhoto(input: {
  scope: HireGuestScope
  body: Buffer
  declaredContentType?: string
  now?: Date
  storage?: HireMediaStoragePort
}): Promise<IHireMediaAsset> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const storage = input.storage ?? hireMediaStorage
  const normalized = await normalizeIdentityPhoto({
    body: input.body,
    declaredContentType: input.declaredContentType,
  })

  const attempt = await HireInterviewAttempt.findOne({
    ...scopedAttemptFilter(input.scope),
    status: { $in: ['photo_pending', 'ready'] },
  }).lean()
  if (!attempt) {
    throw new HireIdentityMediaError(
      'This interview attempt cannot accept a photo',
      'ATTEMPT_INVALID',
      409,
    )
  }
  const consent = await resolveAttemptConsent(input.scope, attempt.consentReceiptId)
  if (!consent) {
    throw new HireIdentityMediaError(
      'Consent is required before photo capture',
      'CONSENT_REQUIRED',
      409,
    )
  }

  const job = await HireJob.findOne({
    _id: input.scope.jobId,
    workspaceId: input.scope.workspaceId,
  })
    .select('status closedAt')
    .lean()
  if (!job) {
    throw new HireIdentityMediaError(
      'This interview job no longer exists',
      'ROUND_INVALID',
      410,
    )
  }
  const jobPurgeEligibleAt =
    job.status === 'closed' && job.closedAt
      ? addCalendarMonths(job.closedAt, 6)
      : undefined

  const assetId = new mongoose.Types.ObjectId()
  const coordinate = {
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    assetId: assetId.toString(),
  }
  const objectKey = hireMediaKey(coordinate, 'identity-photo')
  const asset = await HireMediaAsset.create({
    _id: assetId,
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    jobId: input.scope.jobId,
    candidateId: input.scope.candidateId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    kind: 'identity_photo',
    state: 'staging',
    objectKey,
    contentType: normalized.contentType,
    bytes: normalized.body.byteLength,
    sha256: normalized.sha256,
    width: normalized.width,
    height: normalized.height,
    capturedAt: now,
    ...(jobPurgeEligibleAt
      ? { purgeEligibleAt: jobPurgeEligibleAt, purgeReason: 'job_closed' }
      : {}),
  })

  try {
    await storage.upload({
      key: objectKey,
      body: normalized.body,
      contentType: normalized.contentType,
    })
  } catch (error) {
    await HireMediaAsset.updateOne(
      {
        _id: assetId,
        workspaceId: input.scope.workspaceId,
        applicationId: input.scope.applicationId,
        roundId: input.scope.roundId,
        attemptId: input.scope.attemptId,
        state: 'staging',
      },
      {
        $set: {
          purgeEligibleAt: now,
          purgeReason: 'stale_staging',
          purgeFailureCode: 'UPLOAD_FAILED_OR_UNCERTAIN',
        },
      },
    )
    throw error
  }

  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      const workspaceFence = await HireWorkspace.updateOne(
        {
          _id: input.scope.workspaceId,
          $or: [
            { lifecycleState: 'active' },
            { lifecycleState: { $exists: false } },
          ],
        },
        { $inc: { writeFenceVersion: 1 } },
        { session: dbSession },
      )
      if (workspaceFence.matchedCount !== 1) {
        throw new HireIdentityMediaError(
          'This interview invitation is no longer valid',
          'ROUND_INVALID',
          410,
        )
      }
      await HireMediaAsset.updateMany(
        {
          workspaceId: input.scope.workspaceId,
          applicationId: input.scope.applicationId,
          roundId: input.scope.roundId,
          attemptId: input.scope.attemptId,
          kind: 'identity_photo',
          active: true,
          _id: { $ne: assetId },
        },
        {
          $set: { purgeEligibleAt: now, purgeReason: 'replaced' },
          $unset: { active: 1 },
        },
        { session: dbSession },
      )
      const ready = await HireMediaAsset.updateOne(
        {
          _id: assetId,
          workspaceId: input.scope.workspaceId,
          applicationId: input.scope.applicationId,
          roundId: input.scope.roundId,
          attemptId: input.scope.attemptId,
          state: 'staging',
        },
        {
          $set: {
            state: 'ready',
            active: true,
            ...(jobPurgeEligibleAt
              ? { purgeEligibleAt: jobPurgeEligibleAt, purgeReason: 'job_closed' }
              : {}),
          },
          $unset: {
            ...(!jobPurgeEligibleAt ? { purgeEligibleAt: 1, purgeReason: 1 } : {}),
            purgeFailureCode: 1,
          },
        },
        { session: dbSession },
      )
      if (ready.matchedCount !== 1) {
        throw new HireIdentityMediaError(
          'The photo upload changed before it could be attached',
          'ATTEMPT_INVALID',
          409,
        )
      }
      const attached = await HireInterviewAttempt.updateOne(
        {
          ...scopedAttemptFilter(input.scope),
          status: { $in: ['photo_pending', 'ready'] },
        },
        {
          $set: { identityPhotoAssetId: assetId, status: 'ready' },
        },
        { session: dbSession },
      )
      if (attached.matchedCount !== 1) {
        throw new HireIdentityMediaError(
          'This interview attempt cannot accept a photo',
          'ATTEMPT_INVALID',
          409,
        )
      }
    })
  } catch (error) {
    await HireMediaAsset.updateOne(
      {
        _id: assetId,
        workspaceId: input.scope.workspaceId,
        applicationId: input.scope.applicationId,
        roundId: input.scope.roundId,
        attemptId: input.scope.attemptId,
      },
      {
        $set: {
          purgeEligibleAt: now,
          purgeReason: 'stale_staging',
          purgeFailureCode: 'ATTACH_FAILED',
        },
        $unset: { active: 1 },
      },
    )
    throw error
  } finally {
    await dbSession.endSession()
  }

  const attachedAsset = await HireMediaAsset.findOne({
    _id: assetId,
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    state: 'ready',
    active: true,
  })
  if (!attachedAsset) {
    throw new HireIdentityMediaError(
      'The photo could not be attached',
      'ATTEMPT_INVALID',
      409,
    )
  }
  return attachedAsset
}

export async function startHireInterviewAttempt(input: {
  scope: HireGuestScope
  now?: Date
}): Promise<{
  attemptId: string
  recordingEpoch: Date
  consent: HireAttemptConsent
}> {
  await connectHireControlDB()
  const now = input.now ?? new Date()
  const round = await HireRound.exists({
    _id: input.scope.roundId,
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    jobId: input.scope.jobId,
    candidateId: input.scope.candidateId,
    inviteTokenExpiry: { $gt: now },
    status: { $nin: ['completed', 'revoked'] },
    revokedAt: { $exists: false },
  })
  if (!round) {
    throw new HireIdentityMediaError(
      'This interview invitation is no longer valid',
      'ROUND_INVALID',
      410,
    )
  }
  const attempt = await HireInterviewAttempt.findOne({
    ...scopedAttemptFilter(input.scope),
    status: { $in: ['ready', 'in_progress'] },
    identityPhotoAssetId: { $exists: true },
  }).lean()
  if (!attempt?.identityPhotoAssetId) {
    throw new HireIdentityMediaError(
      'Capture and confirm your identity photo before starting',
      'ATTEMPT_INVALID',
      409,
    )
  }
  const [consent, photo] = await Promise.all([
    resolveAttemptConsent(input.scope, attempt.consentReceiptId),
    HireMediaAsset.exists({
      _id: attempt.identityPhotoAssetId,
      workspaceId: input.scope.workspaceId,
      applicationId: input.scope.applicationId,
      roundId: input.scope.roundId,
      attemptId: input.scope.attemptId,
      kind: 'identity_photo',
      state: 'ready',
      active: true,
      $or: [
        { purgeEligibleAt: { $exists: false } },
        { purgeEligibleAt: { $gt: now } },
      ],
    }),
  ])
  if (!consent || !photo) {
    throw new HireIdentityMediaError(
      'Consent and a retained identity photo are required before starting',
      'ATTEMPT_INVALID',
      409,
    )
  }
  // Network retries after a successful transition must be safe. A fresh
  // one-time engine handoff can be issued for the same attempt without
  // creating another attempt or moving its recording epoch.
  if (attempt.status === 'in_progress' && attempt.startedAt && attempt.recordingEpoch) {
    return {
      attemptId: attempt._id.toString(),
      recordingEpoch: attempt.recordingEpoch,
      consent,
    }
  }
  const started = await HireInterviewAttempt.findOneAndUpdate(
    {
      ...scopedAttemptFilter(input.scope),
      status: 'ready',
      identityPhotoAssetId: attempt.identityPhotoAssetId,
    },
    { $set: { status: 'in_progress', startedAt: now, recordingEpoch: now } },
    { new: true },
  )
  if (!started) {
    throw new HireIdentityMediaError(
      'This interview attempt has already started or changed',
      'ATTEMPT_INVALID',
      409,
    )
  }
  return { attemptId: started._id.toString(), recordingEpoch: now, consent }
}
