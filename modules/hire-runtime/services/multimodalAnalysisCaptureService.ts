import { createHash, randomBytes } from 'node:crypto'
import {
  HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES,
  HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
  HireMultimodalAnalysisCaptureSchema,
  canonicalHireMultimodalAnalysisJson,
  type HireMultimodalAnalysisCapture,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { HIRE_RUNTIME_WRITE_DRAIN_MS } from '@shared/contracts/hireRuntimeWriteFence'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { deleteFromR2, uploadToR2 } from '@shared/storage/r2'
import { supportsHireMultimodalObservations } from '@hire'
import { HireRuntimeBinding } from '../models/HireRuntimeBinding'
import { HireRuntimeMultimodalAnalysisOutbox } from '../models/HireRuntimeMultimodalAnalysisOutbox'
import { isHireRuntimeMultimodalObservationRetentionPurged } from './multimodalObservationRetentionService'
import { connectHireRuntimeDB } from './runtimeBoundary'

export { HireMultimodalAnalysisCaptureSchema }

export type HireRuntimeMultimodalAnalysisCaptureOutcome =
  | 'accepted'
  | 'disabled'
  | 'already_captured'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

const LANDMARK_CAPTURE_NONCE_HEX_LENGTH = 32

function runtimeLandmarkKey(
  principalId: string,
  runtimeSessionId: string,
  nonce = randomBytes(LANDMARK_CAPTURE_NONCE_HEX_LENGTH / 2).toString('hex'),
): string {
  return `landmarks/${principalId}/${runtimeSessionId}-${nonce}.json`
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
}): Promise<void> {
  await deleteFromR2(input.key, {
    ownerUserId: input.principalId,
    sessionId: input.runtimeSessionId,
  }).catch(() => undefined)
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
  })
  if (!binding) throw new Error('Runtime multimodal analysis crossed its binding')
  if (!binding.runtimeSessionId) throw new Error('Runtime multimodal analysis has no session')
  if (!supportsHireMultimodalObservations(binding.consentVersion)) return 'disabled'

  const coordinates = {
    workspaceId: binding.workspaceId,
    applicationId: binding.applicationId,
    roundId: binding.roundId,
  }
  if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
    return 'disabled'
  }

  const attempt = Math.max(1, binding.attemptCount)
  const existing = await HireRuntimeMultimodalAnalysisOutbox.exists({
    ...coordinates,
    runtimeSessionId: binding.runtimeSessionId,
    attempt,
    revision: 1,
    status: { $in: ['pending', 'published', 'stale'] },
  })
  if (existing) return 'already_captured'

  // Reserve the same write-drain window that privacy revocation waits on.
  // This makes an in-flight browser request unable to recreate data after the
  // durable candidate-deletion fence wins.
  const reserved = await HireRuntimeBinding.updateOne(
    {
      _id: binding._id,
      ...coordinates,
      principalId: binding.principalId,
      runtimeSessionId: binding.runtimeSessionId,
      status: { $in: ['active', 'completed'] },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    },
    {
      $max: {
        runtimeWriteDrainUntil: new Date(now.getTime() + HIRE_RUNTIME_WRITE_DRAIN_MS),
      },
    },
  )
  if (reserved.matchedCount !== 1) return 'disabled'

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
  const key = runtimeLandmarkKey(principalId, runtimeSessionId)
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
  const capturedAt = now.toISOString()
  const eventId = sha256(
    `${binding.roundId.toString()}:${runtimeSessionId}:${attempt}:1:${artifactDigest}`,
  )
  let uploaded = false
  try {
    await uploadToR2(key, body, 'application/json')
    uploaded = true

    try {
      await HireRuntimeMultimodalAnalysisOutbox.create({
        ...coordinates,
        principalId: binding.principalId,
        runtimeSessionId: binding.runtimeSessionId,
        attempt,
        revision: 1,
        consentVersion: binding.consentVersion,
        policyVersion: HIRE_MULTIMODAL_ANALYSIS_POLICY_VERSION,
        eventId,
        artifactDigest,
        capturedAt: now,
        landmarkArtifact: {
          sourceKey: key,
          contentType: 'application/json',
          sizeBytes: body.byteLength,
          sha256: artifactDigest,
        },
        status: 'pending',
        publishAttemptCount: 0,
      })
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        await removeStagedLandmarks({ key, principalId, runtimeSessionId })
        return 'already_captured'
      }
      throw error
    }

    // The outbox is the authoritative source-reference. Keep the legacy
    // session pointer as an inventory aid only; a late session update cannot
    // invalidate the durable winner or cause a competing request to erase it.
    await InterviewSession.updateOne(
      {
        _id: binding.runtimeSessionId,
        userId: binding.principalId,
        organizationId: binding.workspaceId,
      },
      { $set: { facialLandmarksR2Key: key } },
    ).catch(() => undefined)
  } catch (error) {
    if (uploaded) await removeStagedLandmarks({ key, principalId, runtimeSessionId })
    await InterviewSession.updateOne(
      {
        _id: binding.runtimeSessionId,
        userId: binding.principalId,
        organizationId: binding.workspaceId,
        facialLandmarksR2Key: key,
      },
      { $unset: { facialLandmarksR2Key: 1 } },
    ).catch(() => undefined)
    throw error
  }

  // A job-close retention tombstone may win after upload but before outbox
  // insertion. It is a hard suppression barrier, so this request removes its
  // own artifact rather than leaving a delayed source for a later publisher.
  if (await isHireRuntimeMultimodalObservationRetentionPurged(coordinates)) {
    await HireRuntimeMultimodalAnalysisOutbox.deleteMany({
      ...coordinates,
      runtimeSessionId: binding.runtimeSessionId,
    })
    await removeStagedLandmarks({ key, principalId, runtimeSessionId })
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
  isDuplicateKeyError,
}
