import { createHash, randomBytes, randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { HireConsentReceipt } from '../models/HireConsentReceipt'
import { HireInterviewAttempt } from '../models/HireInterviewAttempt'
import { HireJob } from '../models/HireJob'
import {
  createHireMediaIngestionLease,
  HireMediaAsset,
  type IHireMediaAsset,
} from '../models/HireMediaAsset'
import { HireRound } from '../models/HireRound'
import { HireWorkspace } from '../models/HireWorkspace'
import {
  type HireConsentSnapshot,
  isRecognizedHireConsentSnapshot,
} from '../policies/aiInterviewConsent'
import { connectHireControlDB } from './hireControlBoundary'
import {
  HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  HIRE_MEDIA_WRITE_TIMEOUT_MS,
  hireMediaKey,
  hireMediaStorage,
  type HireMediaCoordinate,
  type HireMediaStoragePort,
} from './hireMediaStorage'
import type { HireGuestScope } from './identityConsentService'
import { addCalendarMonths } from './mediaLifecycleService'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'

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

async function compensateFailedIdentityPhoto(input: {
  assetId: mongoose.Types.ObjectId
  scope: HireGuestScope
  objectKey: string
  objectKeyNonce: string
  coordinate: HireMediaCoordinate
  storage: HireMediaStoragePort
  now: Date
  ingestionLeaseId: string
  purgeReason: 'privacy_request' | 'stale_staging'
  failureCode: 'UPLOAD_FAILED_OR_UNCERTAIN' | 'ATTACH_FAILED'
}): Promise<void> {
  const stagingScope = {
    _id: input.assetId,
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    jobId: input.scope.jobId,
    candidateId: input.scope.candidateId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    kind: 'identity_photo' as const,
    objectKey: input.objectKey,
    state: 'staging' as const,
    ingestionLeaseId: input.ingestionLeaseId,
  }

  const purgeClaimId = randomUUID()

  // Claim cleanup before touching storage. If the final attachment transaction
  // committed but returned an unknown result, the row is already ready with its
  // lease cleared, so this CAS misses and its valid active object is preserved.
  let claimed: IHireMediaAsset | null = null
  try {
    claimed = await HireMediaAsset.findOneAndUpdate(
      stagingScope,
      {
        $set: {
          state: 'purge_claimed',
          purgeClaimId,
          purgeClaimedAt: input.now,
          purgeEligibleAt: input.now,
          purgeReason: input.purgeReason,
          purgeFailureCode: input.failureCode,
        },
        $unset: {
          active: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgedAt: 1,
        },
      },
      { new: true },
    )
  } catch {
    // Leased staging remains durable and becomes recoverable at lease expiry.
    return
  }
  if (!claimed) return

  const claimScope = {
    _id: input.assetId,
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    jobId: input.scope.jobId,
    candidateId: input.scope.candidateId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    kind: 'identity_photo' as const,
    objectKey: input.objectKey,
    state: 'purge_claimed' as const,
    purgeClaimId,
  }

  try {
    // The unconditional tombstone linearizes against the conditional media
    // PutObject in either order, including after an ambiguous client result.
    await input.storage.delete({
      key: input.objectKey,
      coordinate: input.coordinate,
      kind: 'identity-photo',
      objectKeyNonce: input.objectKeyNonce,
    })
  } catch {
    await HireMediaAsset.updateOne(
      claimScope,
      {
        $set: {
          state: 'purge_failed',
          purgeEligibleAt: input.now,
          purgeReason: input.purgeReason,
          purgeFailureCode: `${input.failureCode}_TOMBSTONE_FAILED`,
        },
        $unset: {
          active: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgedAt: 1,
        },
      },
    ).catch(() => undefined)
    return
  }

  await HireMediaAsset.updateOne(
    claimScope,
    {
      $set: {
        state: 'purged',
        purgedAt: input.now,
        purgeEligibleAt: input.now,
        purgeReason: input.purgeReason,
      },
      $unset: {
        active: 1,
        purgeClaimId: 1,
        purgeClaimedAt: 1,
        purgeFailureCode: 1,
      },
    },
  ).catch(() => undefined)
}

async function claimHireJobMediaRetention(
  scope: Pick<HireGuestScope, 'workspaceId' | 'jobId'>,
  session: mongoose.ClientSession,
): Promise<{ purgeEligibleAt: Date; purgeReason: 'job_closed' } | undefined> {
  const job = await HireJob.findOneAndUpdate(
    { _id: scope.jobId, workspaceId: scope.workspaceId },
    { $inc: { intakeWriteVersion: 1 } },
    {
      new: true,
      session,
      projection: { status: 1, closedAt: 1 },
    },
  )
  if (!job) {
    throw new HireIdentityMediaError(
      'This interview job no longer exists',
      'ROUND_INVALID',
      410,
    )
  }
  return job.status === 'closed' && job.closedAt
    ? {
        purgeEligibleAt: addCalendarMonths(job.closedAt, 6),
        purgeReason: 'job_closed',
      }
    : undefined
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

  const assetId = new mongoose.Types.ObjectId()
  const objectKeyNonce = randomBytes(32).toString('hex')
  // Retention tests may supply a historical business timestamp. The ingestion
  // lease is concurrency control, so it must always be based on wall-clock time.
  const ingestionLease = createHireMediaIngestionLease()
  const coordinate = {
    workspaceId: input.scope.workspaceId,
    applicationId: input.scope.applicationId,
    roundId: input.scope.roundId,
    attemptId: input.scope.attemptId,
    assetId: assetId.toString(),
  }
  const objectKey = hireMediaKey(
    coordinate,
    'identity-photo',
    objectKeyNonce,
  )
  const stageSession = await mongoose.startSession()
  try {
    await stageSession.withTransaction(async () => {
      // Keep the lock order aligned with workspace deletion: workspace root
      // first, candidate privacy row second, then the child staging record.
      const workspaceFence = await HireWorkspace.updateOne(
        {
          _id: input.scope.workspaceId,
          $or: [
            { lifecycleState: 'active' },
            { lifecycleState: { $exists: false } },
          ],
        },
        { $inc: { writeFenceVersion: 1 } },
        { session: stageSession },
      )
      if (workspaceFence.matchedCount !== 1) {
        throw new HireIdentityMediaError(
          'This interview invitation is no longer valid',
          'ROUND_INVALID',
          410,
        )
      }
      await claimHireCandidatePiiWriteFence({
        workspaceId: input.scope.workspaceId,
        candidateId: input.scope.candidateId,
        session: stageSession,
      })
      const retention = await claimHireJobMediaRetention(
        input.scope,
        stageSession,
      )
      await HireMediaAsset.create(
        [
          {
            _id: assetId,
            workspaceId: input.scope.workspaceId,
            applicationId: input.scope.applicationId,
            jobId: input.scope.jobId,
            candidateId: input.scope.candidateId,
            roundId: input.scope.roundId,
            attemptId: input.scope.attemptId,
            kind: 'identity_photo',
            state: 'staging',
            ...ingestionLease,
            objectKey,
            objectKeyNonce,
            contentType: normalized.contentType,
            bytes: normalized.body.byteLength,
            sha256: normalized.sha256,
            width: normalized.width,
            height: normalized.height,
            capturedAt: now,
            ...retention,
          },
        ],
        { session: stageSession },
      )
    })
  } catch (error) {
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new HireIdentityMediaError(
        'This interview invitation is no longer valid',
        'ROUND_INVALID',
        410,
      )
    }
    throw error
  } finally {
    await stageSession.endSession()
  }

  const remainingLeaseMs =
    ingestionLease.ingestionLeaseExpiresAt.getTime() - Date.now()
  const uploadBudgetMs = Math.min(
    HIRE_MEDIA_WRITE_TIMEOUT_MS,
    remainingLeaseMs - HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  )
  if (uploadBudgetMs <= 0) {
    const error = new Error(
      'Hire identity media lease has insufficient time to start an upload',
    )
    await compensateFailedIdentityPhoto({
      assetId,
      scope: input.scope,
      objectKey,
      objectKeyNonce,
      coordinate,
      storage,
      now,
      ingestionLeaseId: ingestionLease.ingestionLeaseId,
      purgeReason: 'stale_staging',
      failureCode: 'UPLOAD_FAILED_OR_UNCERTAIN',
    })
    throw error
  }

  const uploadController = new AbortController()
  const uploadDeadline = setTimeout(() => {
    uploadController.abort(new Error('Hire identity media upload timed out'))
  }, uploadBudgetMs)
  try {
    try {
      await storage.upload({
        key: objectKey,
        coordinate,
        kind: 'identity-photo',
        objectKeyNonce,
        body: normalized.body,
        contentType: normalized.contentType,
        signal: uploadController.signal,
      })
    } finally {
      clearTimeout(uploadDeadline)
    }
  } catch (error) {
    await compensateFailedIdentityPhoto({
      assetId,
      scope: input.scope,
      objectKey,
      objectKeyNonce,
      coordinate,
      storage,
      now,
      ingestionLeaseId: ingestionLease.ingestionLeaseId,
      purgeReason: 'stale_staging',
      failureCode: 'UPLOAD_FAILED_OR_UNCERTAIN',
    })
    throw error
  }

  const dbSession = await mongoose.startSession()
  try {
    await dbSession.withTransaction(async () => {
      // Preserve workspace-root-first lock ordering during final attachment.
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
      // Verified candidate deletion and identity-photo attachment claim this
      // same row. Whichever transaction loses must retry against the winner's
      // state, so an upload cannot become active behind a privacy tombstone.
      await claimHireCandidatePiiWriteFence({
        workspaceId: input.scope.workspaceId,
        candidateId: input.scope.candidateId,
        session: dbSession,
      })
      const retention = await claimHireJobMediaRetention(input.scope, dbSession)
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
          ingestionLeaseId: ingestionLease.ingestionLeaseId,
          ingestionLeaseExpiresAt: { $gt: new Date() },
        },
        {
          $set: {
            state: 'ready',
            active: true,
            ...retention,
          },
          $unset: {
            ...(!retention ? { purgeEligibleAt: 1, purgeReason: 1 } : {}),
            ingestionLeaseId: 1,
            ingestionLeaseExpiresAt: 1,
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
    const privacyWon = error instanceof HireCandidatePiiTombstoneError
    await compensateFailedIdentityPhoto({
      assetId,
      scope: input.scope,
      objectKey,
      objectKeyNonce,
      coordinate,
      storage,
      now,
      ingestionLeaseId: ingestionLease.ingestionLeaseId,
      purgeReason: privacyWon ? 'privacy_request' : 'stale_staging',
      failureCode: 'ATTACH_FAILED',
    })
    if (privacyWon) {
      throw new HireIdentityMediaError(
        'This interview invitation is no longer valid',
        'ROUND_INVALID',
        410,
      )
    }
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
