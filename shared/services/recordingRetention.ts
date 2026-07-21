import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { deleteFromR2 } from '@shared/storage/r2'
import { aiLogger } from '@shared/logger'

const DEFAULT_REPLAY_RETENTION_DAYS = 30
const DEFAULT_BATCH_SIZE = 100

export interface ReplayRecordingCleanupOptions {
  retentionDays?: number
  batchSize?: number
  now?: Date
  dryRun?: boolean
}

export interface ReplayRecordingCleanupResult {
  scanned: number
  sessionsUpdated: number
  keysDeleted: number
  keysFailed: number
  cutoff: Date
}

function getRetentionDays(input?: number): number {
  if (input && input > 0) return input
  const fromEnv = Number(process.env.REPLAY_RECORDING_RETENTION_DAYS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_REPLAY_RETENTION_DAYS
}

/**
 * Delete old replay-only camera/screen recordings from R2.
 *
 * Transcript, feedback, multimodal analysis, audio-only recordings, and facial
 * landmarks are intentionally preserved. Analysis no longer depends on replay
 * videos, so this controls storage growth without breaking feedback.
 */
export async function cleanupExpiredReplayRecordings(
  options: ReplayRecordingCleanupOptions = {}
): Promise<ReplayRecordingCleanupResult> {
  const retentionDays = getRetentionDays(options.retentionDays)
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

  await connectDB()

  const sessions = await InterviewSession.find({
    status: 'completed',
    completedAt: { $lte: cutoff },
    $or: [
      { recordingR2Key: { $exists: true, $ne: null } },
      { screenRecordingR2Key: { $exists: true, $ne: null } },
    ],
  })
    .select('_id userId recordingR2Key screenRecordingR2Key')
    .limit(batchSize)
    .lean()

  let sessionsUpdated = 0
  let keysDeleted = 0
  let keysFailed = 0

  for (const session of sessions) {
    const unset: Record<string, 1> = {}
    const keys = [
      { field: 'recordingR2Key', sizeField: 'recordingSizeBytes', key: session.recordingR2Key },
      { field: 'screenRecordingR2Key', sizeField: 'screenRecordingSizeBytes', key: session.screenRecordingR2Key },
    ].filter((item): item is { field: string; sizeField: string; key: string } => Boolean(item.key))

    for (const item of keys) {
      try {
        if (!options.dryRun) {
          await deleteFromR2(item.key, {
            ownerUserId: String(session.userId),
            sessionId: String(session._id),
          })
        }
        unset[item.field] = 1
        unset[item.sizeField] = 1
        keysDeleted++
      } catch (err) {
        keysFailed++
        aiLogger.warn({ err, key: item.key, sessionId: session._id }, 'Failed to delete expired replay recording')
      }
    }

    if (Object.keys(unset).length > 0 && !options.dryRun) {
      await InterviewSession.findByIdAndUpdate(session._id, { $unset: unset })
      sessionsUpdated++
    } else if (Object.keys(unset).length > 0) {
      sessionsUpdated++
    }
  }

  aiLogger.info(
    { cutoff, scanned: sessions.length, sessionsUpdated, keysDeleted, keysFailed, dryRun: options.dryRun },
    'Replay recording retention cleanup completed'
  )

  return {
    scanned: sessions.length,
    sessionsUpdated,
    keysDeleted,
    keysFailed,
    cutoff,
  }
}
