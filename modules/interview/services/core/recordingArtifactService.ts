import { InterviewSession } from '@shared/db/models/InterviewSession'
import { aiLogger } from '@shared/logger'
import {
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'
import { deleteFromR2 } from '@shared/storage/r2'

export type RecordingArtifactType =
  | 'recording'
  | 'screen-recording'
  | 'audio-recording'

export class RecordingArtifactKeyRejectedError extends Error {
  constructor() {
    super('Recording artifact key is not bound to this user and session')
    this.name = 'RecordingArtifactKeyRejectedError'
  }
}

export class RecordingArtifactSessionNotFoundError extends Error {
  constructor() {
    super('Interview session not found')
    this.name = 'RecordingArtifactSessionNotFoundError'
  }
}

export interface RecordingArtifactKeyIdentity {
  sessionId: string
  type: RecordingArtifactType
  timestamp: string
}

export function parseRecordingArtifactKey(
  key: string,
  userId: string,
): RecordingArtifactKeyIdentity | null {
  const prefix = `recordings/${userId}/`
  if (!key.startsWith(prefix) || key.includes('..')) return null
  const match = /^([a-fA-F0-9]{24})(?:-(screen|audio))?-(\d{10,16})\.webm$/
    .exec(key.slice(prefix.length))
  if (!match) return null
  return {
    sessionId: match[1],
    type: match[2] === 'screen'
      ? 'screen-recording'
      : match[2] === 'audio'
      ? 'audio-recording'
      : 'recording',
    timestamp: match[3],
  }
}

function keyFieldFor(type: RecordingArtifactType) {
  if (type === 'screen-recording') return 'screenRecordingR2Key' as const
  if (type === 'audio-recording') return 'audioRecordingR2Key' as const
  return 'recordingR2Key' as const
}

export function isSessionRecordingKey(
  key: string,
  type: RecordingArtifactType,
  userId: string,
  sessionId: string,
): boolean {
  // Keys are minted with Date.now(). Parsing the original value is required;
  // recomputing it during finalization would produce a different timestamp.
  const identity = parseRecordingArtifactKey(key, userId)
  return identity?.sessionId === sessionId && identity.type === type
}

function patchFor(
  type: RecordingArtifactType,
  key: string,
  sizeBytes: number,
  durationSeconds?: number,
): Record<string, unknown> {
  if (type === 'screen-recording') {
    return { screenRecordingR2Key: key, screenRecordingSizeBytes: sizeBytes }
  }
  if (type === 'audio-recording') {
    return { audioRecordingR2Key: key, audioRecordingSizeBytes: sizeBytes }
  }
  return {
    recordingR2Key: key,
    recordingSizeBytes: sizeBytes,
    ...(durationSeconds !== undefined ? { recordingDurationSeconds: durationSeconds } : {}),
  }
}

function artifactVersionFieldFor(
  type: RecordingArtifactType,
): 'recordingArtifactVersion' | 'screenRecordingArtifactVersion' | null {
  if (type === 'recording') return 'recordingArtifactVersion'
  if (type === 'screen-recording') return 'screenRecordingArtifactVersion'
  return null
}

export interface AssociateRecordingArtifactInput {
  userId: string
  sessionId: string
  type: RecordingArtifactType
  key: string
  sizeBytes: number
  durationSeconds?: number
}

/**
 * Durably associate one already-uploaded replay object with its owner/session.
 *
 * The User revision and InterviewSession update commit in one transaction, so
 * full-account deletion is ordered against this write. Per-session deletion
 * uses an atomic findOneAndDelete fence on the same session document: whichever
 * operation wins determines whether this update is captured or rejected.
 */
export async function associateRecordingArtifact(
  input: AssociateRecordingArtifactInput,
): Promise<{ accepted: boolean; previousKey?: string }> {
  const { userId, sessionId, type, key, sizeBytes, durationSeconds } = input
  if (!isSessionRecordingKey(key, type, userId, sessionId)) {
    throw new RecordingArtifactKeyRejectedError()
  }

  const keyField = keyFieldFor(type)
  let previousKey: string | undefined
  let accepted = true
  await withActiveJobsAccountWrite(userId, async (mongoSession) => {
    const current = await InterviewSession.findOne(
      { _id: sessionId, userId },
      { [keyField]: 1 },
      {
        session: mongoSession,
      },
    ) as Record<string, unknown> | null

    if (!current) throw new RecordingArtifactSessionNotFoundError()
    const candidate = current[keyField]
    if (typeof candidate === 'string' && candidate !== key) {
      const priorIdentity = parseRecordingArtifactKey(candidate, userId)
      const nextIdentity = parseRecordingArtifactKey(key, userId)
      if (
        priorIdentity?.sessionId === sessionId &&
        priorIdentity.type === type &&
        nextIdentity &&
        BigInt(priorIdentity.timestamp) > BigInt(nextIdentity.timestamp)
      ) {
        // A delayed retry must never roll back a newer accepted recording.
        accepted = false
        return
      }
      previousKey = candidate
    }

    const updated = await InterviewSession.updateOne(
      { _id: sessionId, userId },
      {
        $set: patchFor(type, key, sizeBytes, durationSeconds),
        ...(artifactVersionFieldFor(type)
          ? { $inc: { [artifactVersionFieldFor(type)!]: 1 } }
          : {}),
      },
      { session: mongoSession },
    )
    if ((updated.matchedCount ?? 0) !== 1) {
      throw new RecordingArtifactSessionNotFoundError()
    }
  })

  return { accepted, previousKey }
}

/** Delete an overwritten timestamped object without changing write success. */
export async function cleanupSupersededRecordingArtifact(
  previousKey: string | undefined,
  replacementKey: string,
  ownerUserId: string,
  sessionId: string,
): Promise<void> {
  if (!previousKey || previousKey === replacementKey) return
  try {
    await deleteFromR2(previousKey, { ownerUserId, sessionId })
  } catch (error) {
    // Durable failed-cleanup inventory belongs to the follow-up R2 ledger
    // phase. For now retain the successful association and make the miss loud.
    aiLogger.warn(
      { error, previousKey, replacementKey },
      'Failed to delete superseded replay recording',
    )
  }
}
