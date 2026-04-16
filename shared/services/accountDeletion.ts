/**
 * Account & session deletion service.
 *
 * Backs the privacy/terms promise that users can delete individual
 * interview sessions from /history and their entire account from
 * /settings. Both flows are GDPR-relevant: a delete request must
 * actually remove personal data, not just hide it.
 *
 * Two top-level operations:
 *
 * - `deleteInterviewSession(sessionId, userId)` — fully removes a
 *   single session record, its multimodal analysis, R2 artefacts
 *   (recording, facial landmarks, resume, JD), and the per-session
 *   summary. Verifies ownership.
 *
 * - `deleteUserAccount(userId, email)` — cascading delete across every
 *   collection that references the user, including the User document,
 *   NextAuth adapter collections (accounts, sessions, verification
 *   tokens), and the WaitlistEntry document if present. Returns a
 *   summary of what was removed for logging.
 *
 * R2 deletes are best-effort: a failed object delete is logged but
 * never blocks the database delete. Orphaned objects are cheaper to
 * sweep later than to leave a half-deleted account.
 */

import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import mongoClientPromise from '@shared/db/mongoClient'
import { logger } from '@shared/logger'
import { deleteFromR2 } from '@shared/storage/r2'

import {
  User,
  InterviewSession,
  MultimodalAnalysis,
  UsageRecord,
  WaitlistEntry,
  WeaknessCluster,
  UserBadge,
  PathwayPlan,
  WizardSession,
  StreakDay,
  SessionSummary,
  XpEvent,
  SavedJobDescription,
  DailyChallengeAttempt,
  DrillAttempt,
  UserCompetencyState,
} from '@shared/db/models'

// ─── Per-session delete ───────────────────────────────────────────────────────

export interface DeleteSessionResult {
  sessionId: string
  r2KeysDeleted: number
  r2KeysFailed: number
}

export async function deleteInterviewSession(
  sessionId: string,
  userId: string,
  isPlatformAdmin: boolean = false
): Promise<DeleteSessionResult> {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    throw new Error('Invalid session id')
  }
  await connectDB()

  const session = await InterviewSession.findById(sessionId)
  if (!session) throw new Error('Session not found')

  if (session.userId.toString() !== userId && !isPlatformAdmin) {
    throw new Error('Forbidden')
  }

  // Best-effort R2 cleanup. Failures are logged but never block the DB delete.
  const r2Keys: string[] = []
  if (session.recordingR2Key) r2Keys.push(session.recordingR2Key)
  if (session.audioRecordingR2Key) r2Keys.push(session.audioRecordingR2Key)
  if (session.screenRecordingR2Key) r2Keys.push(session.screenRecordingR2Key)
  if (session.facialLandmarksR2Key) r2Keys.push(session.facialLandmarksR2Key)
  if (session.resumeR2Key) r2Keys.push(session.resumeR2Key)
  if (session.jdR2Key) r2Keys.push(session.jdR2Key)

  let r2KeysDeleted = 0
  let r2KeysFailed = 0
  await Promise.all(
    r2Keys.map(async (key) => {
      try {
        await deleteFromR2(key)
        r2KeysDeleted++
      } catch (err) {
        r2KeysFailed++
        logger.warn({ err, key, sessionId }, 'R2 delete failed during session purge')
      }
    })
  )

  // Cascade DB deletes for documents tied to this single session.
  await Promise.all([
    MultimodalAnalysis.deleteOne({ sessionId }),
    SessionSummary.deleteOne({ sessionId }),
    InterviewSession.deleteOne({ _id: sessionId }),
  ])

  logger.info(
    { sessionId, userId, r2KeysDeleted, r2KeysFailed },
    'Interview session fully deleted'
  )

  return { sessionId, r2KeysDeleted, r2KeysFailed }
}

// ─── Full-account cascade delete ──────────────────────────────────────────────

export interface DeleteAccountResult {
  userId: string
  email: string
  collectionsCleared: Record<string, number>
  r2KeysDeleted: number
  r2KeysFailed: number
}

/**
 * Permanently delete the user and every record that references them.
 *
 * Order matters: collect R2 keys from interview sessions first, then
 * cascade-delete every userId-keyed collection, then drop NextAuth
 * adapter collections, then delete the User document last.
 */
export async function deleteUserAccount(
  userId: string,
  email: string
): Promise<DeleteAccountResult> {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid user id')
  }
  await connectDB()

  const userObjectId = new mongoose.Types.ObjectId(userId)

  // 1. Collect R2 keys from all of this user's sessions before we delete the rows.
  const sessions = await InterviewSession.find(
    { userId: userObjectId },
    {
      recordingR2Key: 1,
      audioRecordingR2Key: 1,
      screenRecordingR2Key: 1,
      facialLandmarksR2Key: 1,
      resumeR2Key: 1,
      jdR2Key: 1,
    }
  ).lean()

  const r2Keys: string[] = []
  for (const s of sessions) {
    if (s.recordingR2Key) r2Keys.push(s.recordingR2Key)
    if (s.audioRecordingR2Key) r2Keys.push(s.audioRecordingR2Key)
    if (s.screenRecordingR2Key) r2Keys.push(s.screenRecordingR2Key)
    if (s.facialLandmarksR2Key) r2Keys.push(s.facialLandmarksR2Key)
    if (s.resumeR2Key) r2Keys.push(s.resumeR2Key)
    if (s.jdR2Key) r2Keys.push(s.jdR2Key)
  }

  // Best-effort R2 cleanup, in parallel, capped at 25 concurrent deletes.
  let r2KeysDeleted = 0
  let r2KeysFailed = 0
  const CONCURRENCY = 25
  for (let i = 0; i < r2Keys.length; i += CONCURRENCY) {
    const chunk = r2Keys.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(async (key) => {
        try {
          await deleteFromR2(key)
          r2KeysDeleted++
        } catch (err) {
          r2KeysFailed++
          logger.warn({ err, key, userId }, 'R2 delete failed during account purge')
        }
      })
    )
  }

  // 2. Cascade-delete every collection that references the user via userId.
  const collectionsCleared: Record<string, number> = {}
  const cascadeOps: Array<[string, Promise<{ deletedCount?: number }>]> = [
    ['InterviewSession', InterviewSession.deleteMany({ userId: userObjectId })],
    ['MultimodalAnalysis', MultimodalAnalysis.deleteMany({ userId: userObjectId })],
    ['UsageRecord', UsageRecord.deleteMany({ userId: userObjectId })],
    ['WeaknessCluster', WeaknessCluster.deleteMany({ userId: userObjectId })],
    ['UserBadge', UserBadge.deleteMany({ userId: userObjectId })],
    ['PathwayPlan', PathwayPlan.deleteMany({ userId: userObjectId })],
    ['WizardSession', WizardSession.deleteMany({ userId: userObjectId })],
    ['StreakDay', StreakDay.deleteMany({ userId: userObjectId })],
    ['SessionSummary', SessionSummary.deleteMany({ userId: userObjectId })],
    ['XpEvent', XpEvent.deleteMany({ userId: userObjectId })],
    ['SavedJobDescription', SavedJobDescription.deleteMany({ userId: userObjectId })],
    ['DailyChallengeAttempt', DailyChallengeAttempt.deleteMany({ userId: userObjectId })],
    ['DrillAttempt', DrillAttempt.deleteMany({ userId: userObjectId })],
    ['UserCompetencyState', UserCompetencyState.deleteMany({ userId: userObjectId })],
  ]

  for (const [name, op] of cascadeOps) {
    try {
      const res = await op
      collectionsCleared[name] = res.deletedCount ?? 0
    } catch (err) {
      logger.error({ err, collection: name, userId }, 'Cascade delete failed for collection')
      collectionsCleared[name] = -1
    }
  }

  // 3. WaitlistEntry is keyed by email, not userId.
  if (email) {
    try {
      const res = await WaitlistEntry.deleteMany({ email: email.toLowerCase().trim() })
      collectionsCleared['WaitlistEntry'] = res.deletedCount ?? 0
    } catch (err) {
      logger.warn({ err, email }, 'WaitlistEntry delete failed during account purge')
      collectionsCleared['WaitlistEntry'] = -1
    }
  }

  // 4. NextAuth MongoDB adapter collections live outside the Mongoose models
  //    (accounts, sessions, verification_tokens). Drop them via the raw client.
  try {
    const client = await mongoClientPromise
    const db = client.db()
    const accountsRes = await db.collection('accounts').deleteMany({ userId: userObjectId })
    const sessionsRes = await db.collection('sessions').deleteMany({ userId: userObjectId })
    const tokensRes = await db
      .collection('verification_tokens')
      .deleteMany({ identifier: email })
    collectionsCleared['nextauth.accounts'] = accountsRes.deletedCount ?? 0
    collectionsCleared['nextauth.sessions'] = sessionsRes.deletedCount ?? 0
    collectionsCleared['nextauth.verification_tokens'] = tokensRes.deletedCount ?? 0
  } catch (err) {
    logger.warn({ err, userId }, 'NextAuth adapter cleanup failed')
  }

  // 5. Finally drop the User document itself.
  const userRes = await User.deleteOne({ _id: userObjectId })
  collectionsCleared['User'] = userRes.deletedCount ?? 0

  logger.info(
    { userId, email, collectionsCleared, r2KeysDeleted, r2KeysFailed },
    'User account fully deleted'
  )

  return {
    userId,
    email,
    collectionsCleared,
    r2KeysDeleted,
    r2KeysFailed,
  }
}
