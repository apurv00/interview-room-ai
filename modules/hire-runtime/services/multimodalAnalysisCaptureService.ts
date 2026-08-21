import { createHash, randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import {
  HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES,
  HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
  HireMultimodalAnalysisCaptureSchema,
  canonicalHireMultimodalAnalysisJson,
  type HireMultimodalAnalysisCapture,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { supportsHireMultimodalObservations } from '@hire'
import {
  HireRuntimeBinding,
  type IHireRuntimeBinding,
} from '../models/HireRuntimeBinding'
import {
  HireRuntimeMultimodalAnalysisOutbox,
  type IHireRuntimeMultimodalAnalysisOutbox,
} from '../models/HireRuntimeMultimodalAnalysisOutbox'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import {
  deleteRuntimePersonalObjects,
  isRuntimeLandmarkV2Key,
  runtimeLandmarkV2Key,
  uploadRuntimeLandmarkObject,
} from './runtimeMediaManifest'
import { connectHireRuntimeDB } from './runtimeBoundary'

export { HireMultimodalAnalysisCaptureSchema }

export type HireRuntimeMultimodalAnalysisCaptureOutcome =
  | 'accepted'
  | 'disabled'
  | 'already_captured'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

const LANDMARK_CAPTURE_NONCE_HEX_LENGTH = 64
const LANDMARK_STAGING_LEASE_TOKEN_HEX_LENGTH = 32
const LANDMARK_STAGING_CLEANUP_FAILURE_CODE =
  'RUNTIME_LANDMARK_STAGING_LEASE_EXPIRED'
const MAJORITY_WRITE_CONCERN = { w: 'majority', j: true } as const

class LandmarkCaptureFencedError extends Error {}

function runtimeLandmarkKey(
  principalId: string,
  runtimeSessionId: string,
  objectKeyNonce: string,
): string {
  return runtimeLandmarkV2Key({
    principalId,
    runtimeSessionId,
    objectKeyNonce,
  })
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  )
}

async function removeStagedLandmarks(input: {
  key: string
  principalId: string
  runtimeSessionId: string
  objectKeyNonce?: string
}): Promise<void> {
  await deleteRuntimePersonalObjects({
    principalId: input.principalId,
    objects: [{
      key: input.key,
      runtimeSessionId: input.runtimeSessionId,
      ...(input.objectKeyNonce
        ? { objectKeyNonce: input.objectKeyNonce }
        : {}),
    }],
  })
}

type LandmarkCleanupBinding = Pick<
  IHireRuntimeBinding,
  '_id' | 'workspaceId' | 'principalId' | 'runtimeSessionId' | 'issuedObjectCapabilities'
>

function landmarkCleanupObligations(
  binding: LandmarkCleanupBinding,
  now: Date,
) {
  if (!binding.runtimeSessionId) return []
  const runtimeSessionId = binding.runtimeSessionId.toString()
  return (binding.issuedObjectCapabilities ?? []).filter(
    (capability) =>
      capability.runtimeSessionId.toString() === runtimeSessionId &&
      isRuntimeLandmarkV2Key(capability.key) &&
      capability.expiresAt <= now,
  )
}

async function releaseLandmarkCleanupObligation(input: {
  binding: LandmarkCleanupBinding
  key: string
  objectKeyNonce?: string
}): Promise<void> {
  await HireRuntimeBinding.updateOne(
    {
      _id: input.binding._id,
      workspaceId: input.binding.workspaceId,
    },
    {
      $pull: {
        issuedObjectCapabilities: {
          key: input.key,
          objectKeyNonce: input.objectKeyNonce,
          runtimeSessionId: input.binding.runtimeSessionId,
        },
      },
    },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
}

async function reconcileLandmarkCleanupObligations(input: {
  binding: LandmarkCleanupBinding
  authoritativeKey?: string
  now: Date
}): Promise<void> {
  const principalId = input.binding.principalId.toString()
  for (const obligation of landmarkCleanupObligations(input.binding, input.now)) {
    // A crash after the outbox insert but before the handoff pull can leave the
    // same key in both inventories. The publishable outbox wins; only remove
    // keys that never became its authoritative artifact.
    if (obligation.key !== input.authoritativeKey) {
      await removeStagedLandmarks({
        key: obligation.key,
        principalId,
        runtimeSessionId: obligation.runtimeSessionId.toString(),
        objectKeyNonce: obligation.objectKeyNonce,
      })
    }
    await releaseLandmarkCleanupObligation({
      binding: input.binding,
      key: obligation.key,
      objectKeyNonce: obligation.objectKeyNonce,
    })
  }
}

async function stageLandmarkCaptureOutbox(input: {
  binding: LandmarkCleanupBinding & Pick<
    IHireRuntimeBinding,
    'applicationId' | 'roundId' | 'status' | 'consentVersion' | 'attemptCount'
  >
  key: string
  objectKeyNonce: string
  attempt: number
  eventId: string
  artifactDigest: string
  artifactSizeBytes: number
  capturedAt: Date
  stagingLeaseToken: string
  stagingLeaseExpiresAt: Date
}): Promise<IHireRuntimeMultimodalAnalysisOutbox> {
  const session = await mongoose.startSession()
  let staged: IHireRuntimeMultimodalAnalysisOutbox | undefined
  try {
    await session.withTransaction(async () => {
      // This transaction is the linearization point against privacy and
      // retention fences on the same binding row: the exact key moves from
      // the pre-Put capability inventory into a non-publishable outbox, or no
      // handoff occurs at all.
      const transferred = await HireRuntimeBinding.updateOne(
        {
          _id: input.binding._id,
          workspaceId: input.binding.workspaceId,
          applicationId: input.binding.applicationId,
          roundId: input.binding.roundId,
          principalId: input.binding.principalId,
          runtimeSessionId: input.binding.runtimeSessionId,
          attemptCount: input.attempt,
          status: { $in: ['active', 'completed'] },
          revokedAt: { $exists: false },
          purgePersonalData: { $ne: true },
          multimodalObservationRetentionPurgedAt: { $exists: false },
          issuedObjectCapabilities: {
            $elemMatch: {
              key: input.key,
              objectKeyNonce: input.objectKeyNonce,
              runtimeSessionId: input.binding.runtimeSessionId,
            },
          },
        },
        {
          $pull: {
            issuedObjectCapabilities: {
              key: input.key,
              objectKeyNonce: input.objectKeyNonce,
              runtimeSessionId: input.binding.runtimeSessionId,
            },
          },
        },
        { session },
      )
      if (transferred.matchedCount !== 1) {
        throw new LandmarkCaptureFencedError(
          'Runtime landmark capture lost its binding handoff fence',
        )
      }
      const created = await HireRuntimeMultimodalAnalysisOutbox.create(
        [{
          workspaceId: input.binding.workspaceId,
          applicationId: input.binding.applicationId,
          roundId: input.binding.roundId,
          principalId: input.binding.principalId,
          runtimeSessionId: input.binding.runtimeSessionId,
          attempt: input.attempt,
          revision: 1,
          payloadSnapshotProtocolVersion: 1,
          consentVersion: input.binding.consentVersion,
          policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
          eventId: input.eventId,
          artifactDigest: input.artifactDigest,
          capturedAt: input.capturedAt,
          landmarkArtifact: {
            sourceKey: input.key,
            objectKeyNonce: input.objectKeyNonce,
            contentType: 'application/json',
            sizeBytes: input.artifactSizeBytes,
            sha256: input.artifactDigest,
          },
          status: 'staging',
          stagingLeaseToken: input.stagingLeaseToken,
          stagingLeaseExpiresAt: input.stagingLeaseExpiresAt,
          publishAttemptCount: 0,
        }],
        { session },
      )
      staged = created[0]
    }, {
      writeConcern: MAJORITY_WRITE_CONCERN,
    })
  } finally {
    await session.endSession()
  }
  if (!staged) {
    throw new Error('Runtime landmark staging transaction did not complete')
  }
  return staged
}

type ExistingLandmarkCapture = Pick<
  IHireRuntimeMultimodalAnalysisOutbox,
  | '_id'
  | 'status'
  | 'capturedAt'
  | 'landmarkArtifact'
  | 'stagingLeaseToken'
  | 'stagingLeaseExpiresAt'
>

/**
 * Claims and seals an abandoned staging key before allowing a new capture.
 * The old writer may still complete after its lease expires, so moving the
 * row to `staging_cleanup` and changing the token fences its activation CAS;
 * the permanent seal then wins against any delayed conditional Put.
 */
async function cleanupExpiredLandmarkStaging(input: {
  existing: ExistingLandmarkCapture
  binding: LandmarkCleanupBinding
  now: Date
}): Promise<boolean> {
  if (
    input.existing.status !== 'staging' &&
    input.existing.status !== 'staging_cleanup'
  ) {
    return false
  }
  const sourceKey = input.existing.landmarkArtifact?.sourceKey
  const objectKeyNonce = input.existing.landmarkArtifact?.objectKeyNonce
  if (!sourceKey || !input.binding.runtimeSessionId) return false

  const legacyLeaseCutoff = new Date(
    input.now.getTime() - HIRE_RUNTIME_WRITE_DRAIN_MS,
  )
  const leaseExpired = input.existing.stagingLeaseExpiresAt
    ? input.existing.stagingLeaseExpiresAt <= input.now
    : input.existing.capturedAt <= legacyLeaseCutoff
  if (!leaseExpired) return false

  const cleanupLeaseToken = randomBytes(
    LANDMARK_STAGING_LEASE_TOKEN_HEX_LENGTH / 2,
  ).toString('hex')
  const cleanupLeaseExpiresAt = new Date(
    input.now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS,
  )
  const priorLeaseFilter = input.existing.stagingLeaseToken
    ? {
        stagingLeaseToken: input.existing.stagingLeaseToken,
        stagingLeaseExpiresAt: { $lte: input.now },
      }
    : {
        stagingLeaseToken: { $exists: false },
        stagingLeaseExpiresAt: { $exists: false },
        capturedAt: { $lte: legacyLeaseCutoff },
      }
  const claimed = await HireRuntimeMultimodalAnalysisOutbox.findOneAndUpdate(
    {
      _id: input.existing._id,
      workspaceId: input.binding.workspaceId,
      principalId: input.binding.principalId,
      runtimeSessionId: input.binding.runtimeSessionId,
      status: input.existing.status,
      'landmarkArtifact.sourceKey': sourceKey,
      ...(objectKeyNonce
        ? { 'landmarkArtifact.objectKeyNonce': objectKeyNonce }
        : {}),
      ...priorLeaseFilter,
    },
    {
      $set: {
        status: 'staging_cleanup',
        stagingLeaseToken: cleanupLeaseToken,
        stagingLeaseExpiresAt: cleanupLeaseExpiresAt,
        failureCode: LANDMARK_STAGING_CLEANUP_FAILURE_CODE,
      },
    },
    {
      new: true,
      writeConcern: MAJORITY_WRITE_CONCERN,
    },
  ).lean<ExistingLandmarkCapture | null>()
  if (!claimed) return false

  await removeStagedLandmarks({
    key: sourceKey,
    principalId: input.binding.principalId.toString(),
    runtimeSessionId: input.binding.runtimeSessionId.toString(),
    objectKeyNonce,
  })
  const deleted = await HireRuntimeMultimodalAnalysisOutbox.deleteMany(
    {
      _id: input.existing._id,
      status: 'staging_cleanup',
      stagingLeaseToken: cleanupLeaseToken,
      'landmarkArtifact.sourceKey': sourceKey,
      ...(objectKeyNonce
        ? { 'landmarkArtifact.objectKeyNonce': objectKeyNonce }
        : {}),
    },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (!deleted.acknowledged) {
    throw new Error('Runtime landmark expired staging cleanup was not acknowledged')
  }
  await InterviewSession.updateOne(
    {
      _id: input.binding.runtimeSessionId,
      userId: input.binding.principalId,
      organizationId: input.binding.workspaceId,
      facialLandmarksR2Key: sourceKey,
    },
    { $unset: { facialLandmarksR2Key: 1 } },
  ).catch(() => undefined)
  return true
}

/**
 * Stores the complete, bounded MediaPipe landmark stream in runtime R2. The
 * browser sends this only for the consent version accepted by the current
 * policy helper; raw frames never cross to the control API directly.
 */
export async function captureHireRuntimeMultimodalAnalysis(input: {
  workspaceId: string
  principalId: string
  capture: HireMultimodalAnalysisCapture
  now?: Date
}): Promise<HireRuntimeMultimodalAnalysisCaptureOutcome> {
  await connectHireRuntimeDB()
  const now = input.now ?? new Date()
  const binding = await HireRuntimeBinding.findOne({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeSessionId: input.capture.sessionId,
    status: { $in: ['active', 'completed'] },
    revokedAt: { $exists: false },
    purgePersonalData: { $ne: true },
    multimodalObservationRetentionPurgedAt: { $exists: false },
  })
  if (!binding) throw new Error('Runtime multimodal analysis crossed its binding')
  if (!binding.runtimeSessionId) throw new Error('Runtime multimodal analysis has no session')
  if (!supportsHireMultimodalObservations(binding.consentVersion)) return 'disabled'

  const coordinates = {
    workspaceId: binding.workspaceId,
    applicationId: binding.applicationId,
    roundId: binding.roundId,
  }
  const attempt = Math.max(1, binding.attemptCount)
  const existing = await HireRuntimeMultimodalAnalysisOutbox.findOne({
    ...coordinates,
    runtimeSessionId: binding.runtimeSessionId,
    attempt,
    revision: 1,
    status: { $in: ['staging', 'staging_cleanup', 'pending', 'published', 'stale'] },
  })
    .select('_id status capturedAt landmarkArtifact stagingLeaseToken stagingLeaseExpiresAt')
    .lean<Pick<
      IHireRuntimeMultimodalAnalysisOutbox,
      | '_id'
      | 'status'
      | 'capturedAt'
      | 'landmarkArtifact'
      | 'stagingLeaseToken'
      | 'stagingLeaseExpiresAt'
    >>()
  await reconcileLandmarkCleanupObligations({
    binding,
    authoritativeKey: existing?.landmarkArtifact?.sourceKey,
    now,
  })
  if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
    return 'disabled'
  }
  if (
    existing &&
    !(await cleanupExpiredLandmarkStaging({ existing, binding, now }))
  ) {
    return 'already_captured'
  }

  const runtimeSessionId = binding.runtimeSessionId.toString()
  const principalId = binding.principalId.toString()
  const session = await InterviewSession.exists({
    _id: binding.runtimeSessionId,
    userId: binding.principalId,
    organizationId: binding.workspaceId,
  })
  if (!session) throw new Error('Runtime multimodal analysis session is unavailable')

  // Each browser attempt stages to its own source key. The outbox's existing
  // unique coordinate index elects the winner; a duplicate loser can then
  // delete *only its own* object, never the winner's landmark stream.
  const objectKeyNonce = randomBytes(
    LANDMARK_CAPTURE_NONCE_HEX_LENGTH / 2,
  ).toString('hex')
  const key = runtimeLandmarkKey(
    principalId,
    runtimeSessionId,
    objectKeyNonce,
  )
  const body = Buffer.from(
    canonicalHireMultimodalAnalysisJson({
      schemaVersion: 1,
      frames: input.capture.frames,
    }),
  )
  if (body.byteLength > HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES) {
    throw new Error('Runtime multimodal analysis capture exceeds the body limit')
  }
  const artifactDigest = sha256(body)
  const eventId = sha256(
    `${binding.roundId.toString()}:${runtimeSessionId}:${attempt}:1:${artifactDigest}`,
  )
  const obligationExpiresAt = new Date(
    now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS,
  )
  const stagingLeaseToken = randomBytes(
    LANDMARK_STAGING_LEASE_TOKEN_HEX_LENGTH / 2,
  ).toString('hex')
  // Persist the exact opaque key before crossing into R2. This existing
  // binding inventory is also consumed by verified privacy purge, so an
  // ambiguous Put or failed compensating delete can never create an
  // undiscoverable raw-landmark object.
  const reserved = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      ...coordinates,
      principalId: binding.principalId,
      runtimeSessionId: binding.runtimeSessionId,
      attemptCount: attempt,
      status: { $in: ['active', 'completed'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
      multimodalObservationRetentionPurgedAt: { $exists: false },
    },
    {
      $push: {
        issuedObjectCapabilities: {
          key,
          objectKeyNonce,
          runtimeSessionId: binding.runtimeSessionId,
          expiresAt: obligationExpiresAt,
        },
      },
      $max: { runtimeWriteDrainUntil: obligationExpiresAt },
    },
    {
      writeConcern: MAJORITY_WRITE_CONCERN,
      runValidators: true,
    },
  )
  if (reserved.matchedCount !== 1) return 'disabled'

  let staged: IHireRuntimeMultimodalAnalysisOutbox
  try {
    staged = await stageLandmarkCaptureOutbox({
      binding,
      key,
      objectKeyNonce,
      attempt,
      eventId,
      artifactDigest,
      artifactSizeBytes: body.byteLength,
      capturedAt: now,
      stagingLeaseToken,
      stagingLeaseExpiresAt: obligationExpiresAt,
    })
  } catch (error) {
    // The transaction rolled back its capability pull. Seal first, then drop
    // that exact majority-acknowledged pre-Put obligation.
    await removeStagedLandmarks({
      key,
      principalId,
      runtimeSessionId,
      objectKeyNonce,
    })
    await releaseLandmarkCleanupObligation({ binding, key, objectKeyNonce })
    if (error instanceof LandmarkCaptureFencedError) return 'disabled'
    if (isDuplicateKeyError(error)) return 'already_captured'
    throw error
  }

  try {
    await uploadRuntimeLandmarkObject({
      key,
      principalId,
      runtimeSessionId,
      objectKeyNonce,
      body,
    })
  } catch (error) {
    // The staging outbox is now the durable inventory. Remove it only after
    // the permanent seal acknowledges; a failed seal leaves the row retryable
    // by retention/privacy cleanup.
    await removeStagedLandmarks({
      key,
      principalId,
      runtimeSessionId,
      objectKeyNonce,
    })
    const deleted = await HireRuntimeMultimodalAnalysisOutbox.deleteMany(
      { _id: staged._id, status: 'staging', stagingLeaseToken },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    if (!deleted.acknowledged) {
      throw new Error('Runtime landmark staging cleanup was not acknowledged')
    }
    if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
      return 'disabled'
    }
    throw error
  }

  // Only an acknowledged conditional Put may make the staged artifact
  // publishable. Privacy/retention deletion can remove the staging row first;
  // that CAS miss is fenced and the exact key is sealed again.
  const activated = await HireRuntimeMultimodalAnalysisOutbox.updateOne(
    {
      _id: staged._id,
      status: 'staging',
      stagingLeaseToken,
      'landmarkArtifact.sourceKey': key,
    },
    {
      $set: { status: 'pending' },
      $unset: { stagingLeaseToken: 1, stagingLeaseExpiresAt: 1 },
    },
    { writeConcern: MAJORITY_WRITE_CONCERN },
  )
  if (activated.matchedCount !== 1) {
    await removeStagedLandmarks({
      key,
      principalId,
      runtimeSessionId,
      objectKeyNonce,
    })
    await HireRuntimeMultimodalAnalysisOutbox.deleteMany(
      { _id: staged._id, status: { $in: ['staging', 'stale'] } },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
      return 'disabled'
    }
    throw new LandmarkCaptureFencedError(
      'Runtime landmark capture lost its publishable outbox handoff',
    )
  }

  // A job-close retention tombstone may win after upload but before the final
  // check. It is a hard suppression barrier, so this request removes its
  // own artifact rather than leaving a delayed source for a later publisher.
  if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
    // Keep the outbox inventory until the exact R2 delete acknowledges.
    await removeStagedLandmarks({
      key,
      principalId,
      runtimeSessionId,
      objectKeyNonce,
    })
    await HireRuntimeMultimodalAnalysisOutbox.deleteMany(
      {
        ...coordinates,
        runtimeSessionId: binding.runtimeSessionId,
      },
      { writeConcern: MAJORITY_WRITE_CONCERN },
    )
    await InterviewSession.updateOne(
      {
        _id: binding.runtimeSessionId,
        userId: binding.principalId,
        organizationId: binding.workspaceId,
        facialLandmarksR2Key: key,
      },
      { $unset: { facialLandmarksR2Key: 1 } },
    )
    return 'disabled'
  }

  return 'accepted'
}

export const __hireRuntimeMultimodalAnalysisCapture = {
  runtimeLandmarkKey,
  LANDMARK_CAPTURE_NONCE_HEX_LENGTH,
  LANDMARK_STAGING_LEASE_TOKEN_HEX_LENGTH,
  LANDMARK_STAGING_CLEANUP_FAILURE_CODE,
  isDuplicateKeyError,
  landmarkCleanupObligations,
}
