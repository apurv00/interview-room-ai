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
 * Per-session R2 deletes remain best-effort after the atomic session fence.
 * Full-account deletion is stricter: a failed object delete keeps the User in
 * `deleting` state and preserves Mongo key inventory for an idempotent retry.
 */

import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { AppError } from '@shared/errors'
import { getClientPromise } from '@shared/db/mongoClient'
import { logger } from '@shared/logger'
import { deleteFromR2 } from '@shared/storage/r2'
import { tombstoneAccountUsageBuffers } from '@shared/services/usageBuffer'

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
  DailyChallengeAttempt,
  DrillAttempt,
  UserCompetencyState,
  ServedProblem,
  JobApplication,
  ProductEvent,
  LessonEngagement, JobsEmailSend, JobPracticeEvidence } from '@shared/db/models'
import { SavedResume } from '@shared/db/models/SavedResume'

const PERSONAL_DATA_TX_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export const SESSION_PERSONAL_DATA_CAPABILITY_MS = 52 * 60 * 1_000

export class PersonalDataWriteBlockedError extends AppError {
  constructor() {
    super(
      'Account deletion is in progress. New personal data cannot be saved.',
      423,
      'ACCOUNT_DELETION_PENDING',
    )
    this.name = 'PersonalDataWriteBlockedError'
  }
}

export class SessionPersonalDataWriteBlockedError extends AppError {
  constructor() {
    super(
      'Interview session deletion is in progress. New personal data cannot be saved.',
      410,
      'SESSION_DELETION_PENDING',
    )
    this.name = 'SessionPersonalDataWriteBlockedError'
  }
}

export async function withPersonalDataWriteTransaction<T>(
  userId: string | mongoose.Types.ObjectId,
  work: (
    session: ClientSession,
    userObjectId: mongoose.Types.ObjectId,
  ) => Promise<T>,
): Promise<T> {
  const normalizedUserId = userId.toString()
  if (!mongoose.Types.ObjectId.isValid(normalizedUserId)) {
    throw new PersonalDataWriteBlockedError()
  }
  await connectDB()
  const userObjectId = new mongoose.Types.ObjectId(normalizedUserId)
  const session = await mongoose.startSession()
  try {
    let completed = false
    let result!: T
    await session.withTransaction(async () => {
      const claim = await User.updateOne(
        {
          _id: userObjectId,
          accountState: { $ne: 'deleting' },
          buyerState: { $ne: 'deletion_pending' },
        },
        { $inc: { personalDataWriteVersion: 1 } },
        { session },
      )
      if (claim.matchedCount !== 1) {
        throw new PersonalDataWriteBlockedError()
      }
      result = await work(session, userObjectId)
      completed = true
    }, PERSONAL_DATA_TX_OPTIONS)
    if (!completed) {
      throw new Error('Personal-data transaction returned no result')
    }
    return result
  } finally {
    await session.endSession()
  }
}

export async function withSessionPersonalDataWriteTransaction<T>(
  userId: string | mongoose.Types.ObjectId,
  interviewSessionId: string | mongoose.Types.ObjectId,
  work: (
    session: ClientSession,
    userObjectId: mongoose.Types.ObjectId,
    interviewSessionObjectId: mongoose.Types.ObjectId,
  ) => Promise<T>,
): Promise<T> {
  const normalizedSessionId = interviewSessionId.toString()
  if (!mongoose.Types.ObjectId.isValid(normalizedSessionId)) {
    throw new SessionPersonalDataWriteBlockedError()
  }
  const interviewSessionObjectId = new mongoose.Types.ObjectId(
    normalizedSessionId,
  )
  return withPersonalDataWriteTransaction(
    userId,
    async (session, userObjectId) => {
      const claim = await InterviewSession.updateOne(
        {
          _id: interviewSessionObjectId,
          userId: userObjectId,
          deletionPendingAt: { $exists: false },
        },
        { $inc: { personalDataWriteVersion: 1 } },
        { session },
      )
      if (claim.matchedCount !== 1) {
        throw new SessionPersonalDataWriteBlockedError()
      }
      return work(
        session,
        userObjectId,
        interviewSessionObjectId,
      )
    },
  )
}

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

  // Readiness evidence rows are session-scoped personal data
  // (READINESS.md §1, panel R26). Capture existing evidence owners before
  // deleting; the final ticker mutation below independently catches an
  // application attached after this lookup.
  const evidenceAppIds = await JobPracticeEvidence.distinct('applicationId', { sessionId })
  // Evidence rows are canonical DB writes, but filter defensively so a
  // malformed legacy row cannot throw a CastError after the session fence.
  // Never use session.attribution.applicationId here: historical values came
  // from the browser. The post-delete ticker predicate is the canonical net.
  const readinessAppIds = Array.from(new Set(
    evidenceAppIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => String(id))
  ))

  // Delete the session first: this is the durable fence observed by the
  // attribution worker's post-write check. Evidence cleanup must happen
  // after it, never in the same Promise.all, or a late writer can resurrect
  // rows after the cleanup wins its race.
  const deleteFilter = isPlatformAdmin
    ? { _id: sessionId }
    : { _id: sessionId, userId }
  const deletedSession = await InterviewSession.findOneAndDelete(deleteFilter)
  if (!deletedSession) throw new Error('Session not found')
  const deletedOwnerId = deletedSession.userId

  // Redact the served-problem ledger's stored AI problem body for the latest
  // problem ids captured by the atomic session fence. The ledger row itself
  // stays (it's the cross-session no-repeat memory; deleting it would
  // re-enable repeats), but generated content must not outlive the session.
  // Best-effort: a redaction failure never blocks the session delete.
  // Codex P2 on #485.
  const redactTargets: Array<['coding' | 'system-design', string | undefined]> = [
    ['coding', deletedSession.codingProblemId],
    ['system-design', deletedSession.designProblemId],
  ]
  for (const [kind, problemId] of redactTargets) {
    if (!problemId) continue
    try {
      await ServedProblem.updateOne(
        { userId: deletedOwnerId, kind, problemId },
        { $unset: { problemBody: 1 } }
      )
    } catch (err) {
      logger.warn({ err, sessionId, kind, problemId }, 'ServedProblem body redaction failed during session delete')
    }
  }

  // The atomic delete returns the latest document at the session fence. An
  // artifact key associated before this operation is therefore included;
  // an association ordered after it cannot find the session and must
  // compensate its own upload. R2 cleanup remains best-effort and happens
  // only after the durable Mongo ordering point.
  const r2Keys: string[] = []
  if (deletedSession.recordingR2Key) r2Keys.push(deletedSession.recordingR2Key)
  if (deletedSession.audioRecordingR2Key) r2Keys.push(deletedSession.audioRecordingR2Key)
  if (deletedSession.screenRecordingR2Key) r2Keys.push(deletedSession.screenRecordingR2Key)
  if (deletedSession.facialLandmarksR2Key) r2Keys.push(deletedSession.facialLandmarksR2Key)
  if (deletedSession.resumeR2Key) r2Keys.push(deletedSession.resumeR2Key)
  if (deletedSession.jdR2Key) r2Keys.push(deletedSession.jdR2Key)

  let r2KeysDeleted = 0
  let r2KeysFailed = 0
  await Promise.all(
    r2Keys.map(async (key) => {
      try {
        await deleteFromR2(key, {
          ownerUserId: String(deletedOwnerId),
          sessionId,
        })
        r2KeysDeleted++
      } catch (err) {
        r2KeysFailed++
        logger.warn({ err, key, sessionId }, 'R2 delete failed during session purge')
      }
    })
  )

  // Cascade the remaining documents tied to this single session.
  await Promise.all([
    MultimodalAnalysis.deleteOne({ sessionId }),
    SessionSummary.deleteOne({ sessionId }),
    JobPracticeEvidence.deleteMany({ sessionId }),
  ])

  // Clear (never recompute here — shared/** cannot reach modules/jobs
  // band math) the affected snapshots. Absent snapshot = "no claims",
  // which is the safe direction; the next attribution write rebuilds it
  // from the surviving rows.
  if (readinessAppIds.length > 0) {
    await JobApplication.updateMany(
      { _id: { $in: readinessAppIds }, userId: deletedOwnerId },
      {
        $unset: { readiness: 1 },
        $inc: { readinessRevision: 1 },
      }
    )
  }
  // The deleted session must also leave the applications' session ticker.
  // Unset readiness in the SAME mutation: an attribution writer may have
  // attached the app after evidenceAppIds was captured but before the session
  // deletion fence. This post-delete predicate catches that late attachment.
  await JobApplication.updateMany(
    {
      userId: deletedOwnerId,
      $or: [
        { practiceSessionIds: sessionId },
        { verifiedPracticeSessionIds: sessionId },
      ],
    },
    {
      $unset: { readiness: 1 },
      $inc: { readinessRevision: 1 },
      $pull: {
        practiceSessionIds: sessionId,
        verifiedPracticeSessionIds: sessionId,
      },
    }
  )

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
  /** True when the User row was already absent and the service completed a
   * compensating idempotent sweep before reporting success. */
  alreadyDeleted?: boolean
}

export class AccountDeletionForbiddenError extends Error {
  constructor() {
    super('Platform admins cannot self-delete via this endpoint')
    this.name = 'AccountDeletionForbiddenError'
  }
}

export class AccountDeletionNotFoundError extends Error {
  constructor() {
    super('Account not found')
    this.name = 'AccountDeletionNotFoundError'
  }
}

export class AccountDeletionIncompleteError extends Error {
  constructor(public readonly failedCollections: string[]) {
    super(`Account deletion is incomplete: ${failedCollections.join(', ')}`)
    this.name = 'AccountDeletionIncompleteError'
  }
}

/**
 * Permanently delete the user and every record that references them.
 *
 * Order matters: claim the durable deleting state, collect R2 keys, sweep
 * every user-owned collection, remove auth state, then delete User last. The
 * explicit lifecycle state remains recoverable whenever a mandatory Jobs
 * sweep fails.
 */
export async function deleteUserAccount(
  userId: string,
  _sessionEmail?: string,
): Promise<DeleteAccountResult> {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid user id')
  }
  await connectDB()

  const userObjectId = new mongoose.Types.ObjectId(userId)

  // A04 deletion-start barrier. This is the FIRST durable mutation: every
  // user-owned Jobs creator writes the same User document in its transaction.
  // A writer that commits first is visible to the sweeps below; a deletion
  // that commits first changes the predicate to `deleting`, so the writer
  // retries/fails before it can create data or pin a posting.
  let deletionOwner = await User.findOneAndUpdate(
    {
      _id: userObjectId,
      role: { $ne: 'platform_admin' },
      $or: [
        { accountState: 'active' },
        { accountState: { $exists: false } },
      ],
    },
    {
      $set: {
        accountState: 'deleting',
        accountDeletionRequestedAt: new Date(),
      },
      $inc: { jobsWriteRevision: 1 },
    },
    { new: true, writeConcern: { w: 'majority' } },
  ).select('_id email role accountState resumeR2Key').lean()
  let missingUserRecovery = false

  if (!deletionOwner) {
    const existing = await User.findById(userObjectId)
      .select('_id email role accountState resumeR2Key')
      .lean()
    if (!existing) {
      // A lost-success retry and a legacy partial deletion are indistinguishable
      // once User is gone. Missing User is already a durable write fence, so
      // run the full userId-keyed cascade again. Only report idempotent success
      // after every mandatory Jobs sweep below has completed.
      missingUserRecovery = true
    } else {
      if (existing.role === 'platform_admin') throw new AccountDeletionForbiddenError()
      // A previous attempt may have established the durable barrier and then
      // failed a mandatory sweep. Re-entering is the recovery path.
      if (existing.accountState !== 'deleting') {
        throw new AccountDeletionIncompleteError(['account lifecycle claim'])
      }
      deletionOwner = existing
    }
  }

  // Email and role are account authority. JWT snapshots can be seven days
  // old, so never use the caller-supplied email for privacy deletion.
  const email = String(deletionOwner?.email ?? '').toLowerCase().trim()

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
  if (deletionOwner?.resumeR2Key) r2Keys.push(deletionOwner.resumeR2Key)
  for (const s of sessions) {
    if (s.recordingR2Key) r2Keys.push(s.recordingR2Key)
    if (s.audioRecordingR2Key) r2Keys.push(s.audioRecordingR2Key)
    if (s.screenRecordingR2Key) r2Keys.push(s.screenRecordingR2Key)
    if (s.facialLandmarksR2Key) r2Keys.push(s.facialLandmarksR2Key)
    if (s.resumeR2Key) r2Keys.push(s.resumeR2Key)
    if (s.jdR2Key) r2Keys.push(s.jdR2Key)
  }

  let usageBufferCleanupFailed = false
  try {
    await tombstoneAccountUsageBuffers(
      userId,
      sessions.map((session) => String(session._id)),
    )
  } catch (err) {
    usageBufferCleanupFailed = true
    logger.error({ err, userId }, 'Mandatory usage-buffer deletion fence failed')
  }

  // R2 cleanup is part of verified deletion. Stop before removing Mongo rows
  // when any object cannot be deleted so their key inventory remains durable
  // and the idempotent deleting-state retry can finish the purge.
  let r2KeysDeleted = 0
  let r2KeysFailed = 0
  const CONCURRENCY = 25
  for (let i = 0; i < r2Keys.length; i += CONCURRENCY) {
    const chunk = r2Keys.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(async (key) => {
        try {
          await deleteFromR2(key, { ownerUserId: userId })
          r2KeysDeleted++
        } catch (err) {
          r2KeysFailed++
          logger.warn({ err, key, userId }, 'R2 delete failed during account purge')
        }
      })
    )
  }
  if (r2KeysFailed > 0) {
    throw new AccountDeletionIncompleteError(['R2 artifacts'])
  }

  // 2. Delete sessions first. The account lifecycle marker above prevents a
  // Jobs practice creator from crossing this sweep.
  const collectionsCleared: Record<string, number> = {}
  try {
    const res = await InterviewSession.deleteMany({ userId: userObjectId })
    collectionsCleared.InterviewSession = res.deletedCount ?? 0
  } catch (err) {
    logger.error({ err, collection: 'InterviewSession', userId }, 'Cascade delete failed for collection')
    collectionsCleared.InterviewSession = -1
  }

  // 3. Cascade-delete the remaining user-scoped collections in parallel.
  // User-owned Jobs creator collections are swept in the mandatory final
  // phase below, after the rest of the cascade has settled.
  const cascadeOps: Array<[string, Promise<{ deletedCount?: number }>]> = [
    ['MultimodalAnalysis', MultimodalAnalysis.deleteMany({ userId: userObjectId })],
    ['WeaknessCluster', WeaknessCluster.deleteMany({ userId: userObjectId })],
    ['UserBadge', UserBadge.deleteMany({ userId: userObjectId })],
    ['PathwayPlan', PathwayPlan.deleteMany({ userId: userObjectId })],
    ['WizardSession', WizardSession.deleteMany({ userId: userObjectId })],
    ['StreakDay', StreakDay.deleteMany({ userId: userObjectId })],
    ['SessionSummary', SessionSummary.deleteMany({ userId: userObjectId })],
    ['XpEvent', XpEvent.deleteMany({ userId: userObjectId })],
    ['DailyChallengeAttempt', DailyChallengeAttempt.deleteMany({ userId: userObjectId })],
    ['DrillAttempt', DrillAttempt.deleteMany({ userId: userObjectId })],
    ['UserCompetencyState', UserCompetencyState.deleteMany({ userId: userObjectId })],
    ['ServedProblem', ServedProblem.deleteMany({ userId: userObjectId })],
    ['SavedResume', SavedResume.deleteMany({ userId: userObjectId })],
    // Pre-existing gap surfaced by the Wave-1b GDPR completeness tripwire:
    // per-user lesson engagement rows survived account deletion.
    ['LessonEngagement', LessonEngagement.deleteMany({ userId: userObjectId })],
    // Legacy purge (Codex on #506): the SavedJobDescription model/route were
    // deleted (jobs Wave 0.3), but rows written before that may survive in
    // Mongo — the privacy deletion path must keep clearing them until the
    // collection is confirmed dropped in prod. Raw collection access since
    // no model exists; a missing db handle (tests / cold start) counts 0.
    ['SavedJobDescription (legacy)', (async () => {
      const db = mongoose.connection.db
      if (!db) return { deletedCount: 0 }
      return db.collection('savedjobdescriptions').deleteMany({ userId: userObjectId })
    })()],
  ]

  // MANDATORY hire sweep. A workspace whose last account-holding member is
  // leaving is deleted with them (founder ruling 2026-08-09) — otherwise it
  // strands third-party PII: résumés, transcripts and recordings of
  // candidates who never had an account here.
  //
  // Reached by DYNAMIC import on purpose: shared/ must keep no static
  // dependency on a module (boundary rule), and a registration hook would
  // fail OPEN — if nothing had imported the hire module, the sweep would
  // silently never run, which on a deletion path is the one failure mode
  // that must not exist. A failure here is fatal to the deletion, exactly
  // like the other mandatory sweeps.
  try {
    const { deleteOrphanedWorkspacesForUser } = await import('@hire')
    const hireCleared = await deleteOrphanedWorkspacesForUser(userObjectId)
    for (const [name, count] of Object.entries(hireCleared)) {
      collectionsCleared[name] = (collectionsCleared[name] ?? 0) + count
    }
  } catch (err) {
    logger.error({ err, userId }, 'Hire workspace cascade failed — deletion incomplete')
    throw new AccountDeletionIncompleteError(['hire workspace cascade'])
  }

  for (const [name, op] of cascadeOps) {
    try {
      const res = await op
      collectionsCleared[name] = res.deletedCount ?? 0
    } catch (err) {
      logger.error({ err, collection: name, userId }, 'Cascade delete failed for collection')
      collectionsCleared[name] = -1
    }
  }

  // 4. WaitlistEntry is keyed by email, not userId.
  if (email) {
    try {
      const res = await WaitlistEntry.deleteMany({ email: email.toLowerCase().trim() })
      collectionsCleared['WaitlistEntry'] = res.deletedCount ?? 0
    } catch (err) {
      logger.warn({ err, email }, 'WaitlistEntry delete failed during account purge')
      collectionsCleared['WaitlistEntry'] = -1
    }
  }

  // 5. NextAuth MongoDB adapter collections live outside the Mongoose models
  //    (accounts, sessions, verification_tokens). Drop them via the raw client.
  try {
    const client = await getClientPromise()
    const db = client.db()
    const accountsRes = await db.collection('accounts').deleteMany({ userId: userObjectId })
    const sessionsRes = await db.collection('sessions').deleteMany({ userId: userObjectId })
    collectionsCleared['nextauth.accounts'] = accountsRes.deletedCount ?? 0
    collectionsCleared['nextauth.sessions'] = sessionsRes.deletedCount ?? 0
    // Verification tokens are keyed only by canonical email. In a
    // missing-User recovery that authority is no longer available, and an
    // empty identifier is not a safe proxy for the deleted account.
    if (email) {
      const tokensRes = await db
        .collection('verification_tokens')
        .deleteMany({ identifier: email })
      collectionsCleared['nextauth.verification_tokens'] = tokensRes.deletedCount ?? 0
    }
  } catch (err) {
    logger.warn({ err, userId }, 'NextAuth adapter cleanup failed')
    collectionsCleared['nextauth.accounts'] = -1
    collectionsCleared['nextauth.sessions'] = -1
    if (email) collectionsCleared['nextauth.verification_tokens'] = -1
  }

  // 6. Mandatory Jobs/user-side-effect sweep. Once the opening marker
  // committed, every protected creator is totally ordered before or after
  // it. Anything ordered before is removed here; anything ordered after is
  // rejected. Keep the deleting User as a recoverable fence if any sweep
  // fails, rather than returning a false-success deletion with orphan rows.
  const finalJobsOps: Array<[string, Promise<{ deletedCount?: number }>]> = [
    ['UsageRecord', UsageRecord.deleteMany({ userId: userObjectId })],
    ['ProductEvent', ProductEvent.deleteMany({ userId: userObjectId })],
    ['JobsEmailSend', JobsEmailSend.deleteMany({ userId: userObjectId })],
    ['JobPracticeEvidence', JobPracticeEvidence.deleteMany({ userId: userObjectId })],
    ['JobApplication', JobApplication.deleteMany({ userId: userObjectId })],
  ]
  const failedMandatorySweeps = Object.entries(collectionsCleared)
    .filter(([, deletedCount]) => deletedCount === -1)
    .map(([name]) => name)
  if (usageBufferCleanupFailed) failedMandatorySweeps.push('UsageBuffer')
  for (const [name, op] of finalJobsOps) {
    try {
      const res = await op
      collectionsCleared[name] = res.deletedCount ?? 0
    } catch (err) {
      logger.error({ err, collection: name, userId }, 'Mandatory Jobs cascade delete failed')
      collectionsCleared[name] = -1
      failedMandatorySweeps.push(name)
    }
  }
  if (failedMandatorySweeps.length > 0) {
    throw new AccountDeletionIncompleteError(Array.from(new Set(failedMandatorySweeps)))
  }

  // 7. User is last. Its explicit `deleting` state remains the write fence
  // until every mandatory Jobs sweep above has succeeded.
  const userRes = await User.deleteOne({ _id: userObjectId, accountState: 'deleting' })
  collectionsCleared['User'] = userRes.deletedCount ?? 0
  if ((userRes.deletedCount ?? 0) !== 1) {
    // A concurrent retry may already have removed the row. Anything else is
    // an incomplete deletion: never report success while a lifecycle fence
    // unexpectedly remains present.
    const userStillExists = await User.exists({ _id: userObjectId })
    if (userStillExists) throw new AccountDeletionIncompleteError(['User'])
  }

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
    ...(missingUserRecovery ? { alreadyDeleted: true } : {}),
  }
}
