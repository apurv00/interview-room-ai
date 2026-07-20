import { gunzipSync } from 'zlib'
import { isValidObjectId } from 'mongoose'
import { JobApplication, JobPosting, InterviewSession, ProductEvent, User } from '@shared/db/models'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import { getShortFormMinAnswers } from '@interview/services/eval/sessionScoringPolicy'
import { practiceHandoffHashOf } from './practiceHandoff'
import { xrayHashOf } from './xrayService'
import { jobPostingStateOf } from './postingAccess'

/**
 * Application state transitions (PRODUCT_FLOW §2). `apply_clicked` is a
 * MACHINE FACT — recorded the instant the user opens an apply link, never
 * conflated with the user CLAIM `applied` (the return-sheet's job, Wave 4).
 * Everything downstream (save→apply metrics, the confirm nudges, ghost
 * inference) depends on that honesty.
 *
 * Status machine is loose but never regresses here: a click on a row
 * already at `applied`/`interview_scheduled`/... leaves the status alone —
 * clicking an apply link again is not evidence the pipeline moved backward.
 */

/**
 * Atomically claim the right to enqueue ONE ATS run (Codex on #521):
 * concurrent POSTs (double-click, retry) both passed the read-then-write
 * guard and enqueued two model calls. The marker is claimed with a
 * conditional update — only the request that actually flipped it enqueues.
 */
export async function claimAtsRun(
  userId: string,
  jobPostingId: string,
  now = new Date()
): Promise<{ claimed: boolean; claimedAt: Date }> {
  const staleBefore = new Date(now.getTime() - 3 * 60_000)
  const res = await JobApplication.updateOne(
    {
      userId,
      jobPostingId,
      $or: [{ atsRequestedAt: { $exists: false } }, { atsRequestedAt: { $lt: staleBefore } }],
    },
    { $set: { atsRequestedAt: now } }
  )
  // claimedAt travels through the event: a superseded slow run may only
  // clear the marker IT set — never a newer run's (Codex on #521).
  return { claimed: (res?.modifiedCount ?? 0) === 1, claimedAt: now }
}

/** Rollback for a claim whose enqueue failed — the next click must work. */
export async function releaseAtsClaim(userId: string, jobPostingId: string): Promise<void> {
  await JobApplication.updateOne({ userId, jobPostingId }, { $unset: { atsRequestedAt: 1 } }).catch(() => {})
}

/**
 * Tailored-version persist (§2, Wave 4.5): latest-wins on the application
 * row — NEVER counted against the 3-resume cap (savedResumes is a doc-size
 * bound; the application absorbs per-job volume). Tailoring without a row
 * implicitly saves the job (strongest save signal); jdHash binds the
 * version to the JD it was tailored against.
 */
export async function saveTailoredVersion(
  userId: string,
  jobPostingId: string,
  payload: {
    tailoredText: string
    sourceResumeId?: string
    matchScore?: number
    addedKeywords: string[]
    missingKeywords: string[]
    /** SHA-256 of the exact canonical JD version used by the Tailor run. */
    sourceJdHash: string
  },
  now = new Date()
): Promise<
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'context-unavailable' | 'jd-mismatch' }
> {
  const posting = await JobPosting.findById(jobPostingId).select('title company locations provenance status closedReason jdCompressed').lean()
  if (!posting) return { ok: false, reason: 'not-found' }
  const postingState = jobPostingStateOf(posting)
  const existingApp = await JobApplication.findOne({ userId, jobPostingId }).select('_id').lean()
  // A closed id alone is not ownership proof. Preserve the same not-found
  // boundary as detail: only an existing application may learn why its saved
  // context can no longer accept an exact-job artifact.
  if (postingState !== 'live' && !existingApp) return { ok: false, reason: 'not-found' }
  if (postingState === 'restricted') return { ok: false, reason: 'context-unavailable' }

  let canonicalJd = ''
  try {
    const buf = posting.jdCompressed as Buffer | undefined
    canonicalJd = buf?.length
      ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8')
      : ''
  } catch { /* unreadable canonical JD cannot prove Tailor provenance */ }
  if (!canonicalJd.trim()) return { ok: false, reason: 'context-unavailable' }
  if (payload.sourceJdHash !== practiceHandoffHashOf(canonicalJd)) {
    return { ok: false, reason: 'jd-mismatch' }
  }

  // Validate the posting version and lifecycle in the same write that repairs
  // its retention pin. A merge/closure that wins after the read prevents the
  // application artifact from being attached to stale context.
  const postingGuard = await JobPosting.updateOne(
    {
      _id: jobPostingId,
      status: postingState === 'live' ? 'open' : 'closed',
      ...(postingState === 'archived' ? { closedReason: posting.closedReason } : {}),
      jdCompressed: posting.jdCompressed,
    },
    { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
  )
  if ((postingGuard?.matchedCount ?? 0) !== 1) {
    return { ok: false, reason: 'context-unavailable' }
  }

  // '' would fail the schema's string validation on create (Mongoose treats
  // empty as missing) — paste/upload-sourced tailors simply have no source
  // resume (Codex P1 on #526).
  const tailoredVersion = {
    tailoredText: payload.tailoredText,
    sourceResumeId: payload.sourceResumeId || undefined,
    matchScore: payload.matchScore,
    addedKeywords: payload.addedKeywords,
    missingKeywords: payload.missingKeywords,
    jdHash: xrayHashOf(canonicalJd),
    createdAt: now,
  }
  if (existingApp) {
    const res = await JobApplication.updateOne(
      { _id: existingApp._id, userId, jobPostingId },
      { $set: { tailoredVersion } },
    )
    return (res?.matchedCount ?? 0) > 0
      ? { ok: true }
      : { ok: false, reason: 'context-unavailable' }
  }

  // No row yet: implicit save (mirrors the save route's create + pin).
  // Ownership cannot be manufactured after closure. Bind the retention pin
  // to an open posting in the same atomic write; a close that wins this race
  // prevents application creation.
  if (postingState !== 'live') return { ok: false, reason: 'not-found' }
  try {
    await JobApplication.create({
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
      },
      status: 'saved',
      statusHistory: [{ status: 'saved', at: now, source: 'user' }],
      tailoredVersion,
    })
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      const raced = await JobApplication.updateOne({ userId, jobPostingId }, { $set: { tailoredVersion } })
      if ((raced?.matchedCount ?? 0) !== 1) {
        return { ok: false, reason: 'context-unavailable' }
      }
    } else {
      throw err
    }
  }
  return { ok: true }
}

/** Statuses a USER may set (loose machine: forward jumps and backward
 *  corrections both allowed; ghosted/rejected recoverable). apply_clicked
 *  is the MACHINE fact and is never user-settable. */
export const USER_SETTABLE_STATUSES = ['saved', 'applied', 'interview_scheduled', 'offer', 'rejected', 'ghosted', 'withdrawn'] as const
export type UserSettableStatus = (typeof USER_SETTABLE_STATUSES)[number]

export interface TransitionTelemetry {
  /** Which surface carried the user's claim (EMAILS.md §4). */
  channel: 'web' | 'email'
  latencyMs?: number
  viaNudge?: boolean
  inferredFromPrep?: boolean
}

export async function transitionStatus(
  userId: string,
  jobPostingId: string,
  to: UserSettableStatus,
  telemetry?: TransitionTelemetry,
  now = new Date()
): Promise<{ ok: boolean; status?: string; from?: string }> {
  if (!(USER_SETTABLE_STATUSES as readonly string[]).includes(to)) return { ok: false }
  // findOneAndUpdate returns the PRE-update doc — the event vocabulary
  // promises jobs.status_changed{from,to,source}, and in a loose machine
  // `from` is what distinguishes a forward move from a correction
  // (Codex on #522).
  const prev = await JobApplication.findOneAndUpdate(
    { userId, jobPostingId },
    {
      $set: { status: to, ...(to === 'applied' ? { appliedAt: now } : {}) },
      $push: { statusHistory: { status: to, at: now, source: 'user' } },
    },
    { new: false }
  )
  if (!prev) return { ok: false }

  // THE single emitter (EMAILS.md §4, Codex #530 R25): jobs.interview_scheduled
  // fires HERE on the edge (from != to) and nowhere else — the session-gated
  // status route and any token-gated email action are thin callers, so one
  // scheduled interview stays one event regardless of channel. Telemetry
  // never breaks the transition.
  if (telemetry) {
    try {
      const scheduledEdge = to === 'interview_scheduled' && prev.status !== 'interview_scheduled'
      await ProductEvent.create({
        name: to === 'applied' ? 'jobs.apply_confirmed' : scheduledEdge ? 'jobs.interview_scheduled' : 'jobs.status_changed',
        userId,
        jobPostingId,
        props:
          to === 'applied'
            ? { latencyMs: telemetry.latencyMs, viaNudge: telemetry.viaNudge ?? false, from: prev.status, channel: telemetry.channel }
            : scheduledEdge
              ? { inferredFromPrep: telemetry.inferredFromPrep ?? false, from: prev.status, channel: telemetry.channel }
              : { from: prev.status, to, source: 'user', channel: telemetry.channel },
        ts: now,
      })
    } catch (err) {
      logger.warn({ err }, 'status telemetry write failed')
    }
  }
  return { ok: true, status: to, from: prev.status }
}

/**
 * Broken-link report (§4b): recorded on the application AND counted on the
 * posting's provenance entry — one user's dead click demotes that rung for
 * everyone (heals, never hides; the ladder sort sinks rungs with reports).
 */
export async function reportBrokenLink(
  userId: string,
  jobPostingId: string,
  url: string,
  now = new Date()
): Promise<{ ok: boolean }> {
  // The demotion predicate is a RECORDED DEAD CLICK, not mere row existence
  // (Codex on #522 rounds 2+4): a saved-only row (no click ever) must not
  // unlock posting-level demotion — the application must carry the machine
  // fact (statusHistory contains apply_clicked) before its report counts.
  // URL equality is deliberately NOT required: the snapshot stores only the
  // FIRST click's URL, and reports against alternate rungs are legitimate.
  const app = await JobApplication.updateOne(
    { userId, jobPostingId, 'statusHistory.status': 'apply_clicked' },
    { $push: { brokenLinkReports: { url: url.slice(0, 2000), reportedAt: now } } }
  )
  if ((app?.matchedCount ?? 0) === 0) return { ok: false }
  // arrayFilters, not positional $: the merge appends provenance by
  // sourceKey, so ONE dead URL can sit in several rungs — the positional
  // operator updated only the first, leaving a clean twin ranked ahead of
  // the failover (Codex on #522 round-3).
  await JobPosting.updateOne(
    { _id: jobPostingId, 'provenance.applyUrl': url },
    { $inc: { 'provenance.$[elem].brokenReportCount': 1 } },
    { arrayFilters: [{ 'elem.applyUrl': url }] }
  )
  return { ok: true }
}

export interface EnsuredPracticeApplication {
  applicationId: string
  jobPostingId: string
  sessionId: string
  evidenceCount: number
  /** True only for the write that inserted this session id. */
  newlyAdded: boolean
}

/** One source of truth for whether a persisted evaluation can mint Jobs evidence. */
export function isScorablePracticeEvaluation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const evaluation = value as Record<string, unknown>
  return (
    (evaluation.status ?? 'ok') === 'ok' &&
    typeof evaluation.answer === 'string' &&
    evaluation.answer.trim().length > 0
  )
}

/**
 * Session-level evidence gate. A usable answer is not enough: Jobs evidence
 * is created only after the interview has durably reached completed feedback
 * and met the same type-aware minimum used by generate-feedback.
 */
export function hasCompletedScoredPractice(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const session = value as Record<string, unknown>
  if (session.status !== 'completed') return false
  const feedback = session.feedback
  if (
    !feedback ||
    typeof feedback !== 'object' ||
    typeof (feedback as Record<string, unknown>).overall_score !== 'number'
  ) return false
  const evaluations = Array.isArray(session.evaluations) ? session.evaluations : []
  const interviewType = (session.config as { interviewType?: string } | undefined)?.interviewType
  return evaluations.filter(isScorablePracticeEvaluation).length >= getShortFormMinAnswers(interviewType)
}

function inflateJobDescription(value: unknown): string {
  if (!value) return ''
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from((value as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)
  return gunzipSync(buffer).toString('utf8')
}

/**
 * Resolve a scored Jobs session to its canonical user+posting relationship.
 * Kept separate from event emission so the reconciliation sweep can repair
 * already-lost practice-first sessions without recursively emitting work.
 */
export async function ensurePracticeApplication(
  userId: string,
  sessionId: string,
  now = new Date()
): Promise<EnsuredPracticeApplication | null> {
  const sessionFilter = { _id: sessionId, userId }
  const session = await InterviewSession.findOne(sessionFilter)
    .select('attribution userId jobDescription config evaluations status feedback')
    .lean()
  const attr = session?.attribution as {
    source?: string
    jobId?: string
    applicationId?: string
    handoffVersion?: number
    jdHash?: string
  } | undefined
  if (
    !session ||
    attr?.source !== 'jobs' ||
    !attr.jobId ||
    !isValidObjectId(attr.jobId) ||
    attr.handoffVersion !== 1 ||
    !attr.jdHash ||
    !hasCompletedScoredPractice(session)
  ) return null

  // Full-account deletion removes User before its final JobApplication
  // sweep. Refuse a late side-effect after that durable deletion fence.
  if (!(await User.exists({ _id: userId }))) return null

  // applicationId originates in browser-held config and is advisory only.
  // The unique user+posting pair is the canonical identity and prevents a
  // stale, forged, or malformed application id from cross-attaching evidence.
  const filter = { userId, jobPostingId: attr.jobId }

  // jobId originates in browser-held config too. Bind it to the JD that the
  // server persisted on the session before mutating any posting/application;
  // malformed, stale, cross-job, missing, or corrupt bodies fail closed.
  const posting = await JobPosting.findById(attr.jobId)
    .select('title company locations provenance jdCompressed')
    .lean()
  const sessionJd =
    (session as { jobDescription?: string }).jobDescription ??
    (session.config as { jobDescription?: string } | undefined)?.jobDescription
  let postingJd = ''
  try {
    postingJd = inflateJobDescription(posting?.jdCompressed)
  } catch {
    return null
  }
  const sessionJdHash = sessionJd ? practiceHandoffHashOf(sessionJd) : ''
  if (
    !posting ||
    !sessionJd ||
    !postingJd ||
    sessionJdHash !== attr.jdHash ||
    sessionJdHash !== practiceHandoffHashOf(postingJd)
  ) return null

  // Pin only the exact JD version just verified. If ingestion replaced or
  // removed it between the read and this write, reconciliation can retry
  // against the new server truth instead of cross-attaching stale evidence.
  const pin = await JobPosting.updateOne(
    { _id: attr.jobId, jdCompressed: posting.jdCompressed },
    { $set: { userReferenced: true }, $unset: { purgeAt: 1 } }
  )
  if ((pin?.matchedCount ?? 0) === 0) return null

  const snapshot = {
    title: String(posting.title ?? '').slice(0, 300),
    company: String(posting.company ?? '').slice(0, 300),
    location: String((posting.locations ?? [])[0] ?? '').slice(0, 200),
    source: String(posting.provenance?.[0]?.sourceId ?? 'unknown').slice(0, 100),
  }
  const evidenceFilter = { ...filter, verifiedPracticeSessionIds: { $ne: session._id } }
  const attach = {
    $addToSet: {
      // Keep the historical attendance array for email/backcompat consumers,
      // but only the verified array drives evidence counts.
      practiceSessionIds: session._id,
      verifiedPracticeSessionIds: session._id,
    },
  }

  // The $ne predicate, not modifiedCount, proves this write inserted the
  // session. Mongoose timestamps can otherwise modify updatedAt on a no-op
  // $addToSet and falsely crown every retry as the event-emitting winner.
  let newlyAdded = false
  const existingAttach = await JobApplication.updateOne(evidenceFilter, attach)
  if ((existingAttach?.matchedCount ?? 0) > 0) {
    newlyAdded = true
  } else {
    const alreadyAttached = await JobApplication.findOne({ ...filter, verifiedPracticeSessionIds: session._id })
      .select('_id')
      .lean()
    if (!alreadyAttached) {
      try {
        const result = await JobApplication.updateOne(
          evidenceFilter,
          {
            $setOnInsert: {
              jobSnapshot: snapshot,
              status: 'saved',
              statusHistory: [{ status: 'saved', at: now, source: 'system' }],
            },
            $addToSet: {
              practiceSessionIds: session._id,
              verifiedPracticeSessionIds: session._id,
            },
          },
          { upsert: true, setDefaultsOnInsert: true, runValidators: true }
        )
        newlyAdded = (result?.upsertedCount ?? 0) > 0 || (result?.matchedCount ?? 0) > 0
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err
        // A concurrent Save/Apply/Tailor/practice won the unique tuple. Retry
        // the conditional attach only; never overwrite the winner's state.
        const result = await JobApplication.updateOne(evidenceFilter, attach)
        newlyAdded = (result?.matchedCount ?? 0) > 0
      }
    }
  }

  // Close both single-session and full-account deletion races. Account
  // deletion removes sessions first, User next, and applications last; a
  // writer spanning that sequence either gets swept or observes the fence.
  const [sessionStillExists, userStillExists] = await Promise.all([
    InterviewSession.findOne(sessionFilter).select('_id').lean(),
    User.exists({ _id: userId }),
  ])
  if (!userStillExists) {
    await JobApplication.deleteOne(filter)
    return null
  }
  if (!sessionStillExists) {
    await JobApplication.updateOne(filter, {
      $pull: {
        practiceSessionIds: session._id,
        verifiedPracticeSessionIds: session._id,
      },
    })
    return null
  }

  // Prove the canonical row still exists after the write (account deletion
  // can race this rail) and that it actually contains the evidence before an
  // attribution event is emitted.
  const app = await JobApplication.findOne({ ...filter, verifiedPracticeSessionIds: session._id })
    .select('_id verifiedPracticeSessionIds jobPostingId')
    .lean()
  if (!app) return null

  // Repair stale/missing client-carried attribution so a failed immediate
  // emit remains recoverable by the canonical reconciliation sweep.
  if (String(attr.applicationId ?? '') !== String(app._id)) {
    try {
      await InterviewSession.updateOne(
        {
          _id: session._id,
          userId,
          'attribution.source': 'jobs',
          'attribution.jobId': attr.jobId,
        },
        { $set: { 'attribution.applicationId': String(app._id) } }
      )
    } catch (err) {
      logger.warn({ err, sessionId }, 'practice application attribution repair failed')
    }
  }

  return {
    applicationId: String(app._id),
    jobPostingId: String(app.jobPostingId),
    sessionId: String(session._id),
    evidenceCount: Math.min(3, app.verifiedPracticeSessionIds?.length ?? 0),
    newlyAdded,
  }
}

/**
 * Evidence push (Wave 4.3): scored job-specific practice is an intentional
 * tracking signal. The first session atomically auto-saves the job with a
 * system history entry; retries return the durable count but only the write
 * winner emits attribution work.
 */
export async function recordPracticeEvidence(
  userId: string,
  sessionId: string,
  now = new Date()
): Promise<{ recorded: boolean; evidenceCount?: number }> {
  const ensured = await ensurePracticeApplication(userId, sessionId, now)
  if (!ensured) return { recorded: false }

  if (ensured.newlyAdded) {
    try {
      await inngest.send({
        id: `jobs-evidence-${ensured.sessionId}`,
        name: 'jobs/evidence.attribute',
        data: {
          sessionId: ensured.sessionId,
          applicationId: ensured.applicationId,
          jobPostingId: ensured.jobPostingId,
        },
      })
    } catch (err) {
      logger.warn({ err, sessionId }, 'evidence.attribute emit failed — reconciliation sweep will recover')
    }
  }
  return { recorded: true, evidenceCount: ensured.evidenceCount }
}

export interface ApplyClickResult {
  status: string
  created: boolean
  transitioned: boolean
}

export async function recordApplyClick(
  userId: string,
  jobPostingId: string,
  click: { tier?: string; url?: string },
  now = new Date()
): Promise<ApplyClickResult | null> {
  const posting = await JobPosting.findById(jobPostingId).select('title company locations provenance status').lean()
  if (!posting) return null

  const existing = await JobApplication.findOne({ userId, jobPostingId }).select('status').lean()
  if (existing) {
    // Existing ownership survives closure. Keep its retention pin healthy;
    // a stale tab may still report the real click without granting access to
    // anyone new.
    await JobPosting.updateOne({ _id: jobPostingId }, { $set: { userReferenced: true }, $unset: { purgeAt: 1 } })
    if (existing.status !== 'saved') {
      return { status: existing.status, created: false, transitioned: false }
    }
    const transitioned = await JobApplication.updateOne(
      { userId, jobPostingId, status: 'saved' }, // status in the filter: never race-regress a concurrent forward move
      {
        $set: { status: 'apply_clicked', 'jobSnapshot.applyTierAtClick': click.tier, 'jobSnapshot.applyUrlAtClick': click.url },
        $push: { statusHistory: { status: 'apply_clicked', at: now, source: 'system' } },
      }
    )
    if ((transitioned?.matchedCount ?? 0) > 0) {
      return { status: 'apply_clicked', created: false, transitioned: true }
    }
    const winner = await JobApplication.findOne({ userId, jobPostingId }).select('status').lean()
    return winner ? { status: winner.status, created: false, transitioned: false } : null
  }

  // A first click may create ownership only while the posting is live. The
  // status predicate closes the read→pin race atomically with retention.
  if (posting.status !== 'open') return null
  const pin = await JobPosting.updateOne(
    { _id: jobPostingId, status: 'open' },
    { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
  )
  if ((pin?.matchedCount ?? 0) !== 1) return null

  try {
    await JobApplication.create({
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
        applyTierAtClick: click.tier,
        applyUrlAtClick: click.url,
      },
      status: 'apply_clicked',
      statusHistory: [{ status: 'apply_clicked', at: now, source: 'system' }],
    })
    return { status: 'apply_clicked', created: true, transitioned: true }
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      // A Save/Tailor/practice create may have won. Preserve the Apply
      // machine fact by conditionally advancing a saved winner; if a later
      // status won too, reread it without regression.
      const transitioned = await JobApplication.updateOne(
        { userId, jobPostingId, status: 'saved' },
        {
          $set: { status: 'apply_clicked', 'jobSnapshot.applyTierAtClick': click.tier, 'jobSnapshot.applyUrlAtClick': click.url },
          $push: { statusHistory: { status: 'apply_clicked', at: now, source: 'system' } },
        }
      )
      if ((transitioned?.matchedCount ?? 0) > 0) {
        return { status: 'apply_clicked', created: false, transitioned: true }
      }
      const winner = await JobApplication.findOne({ userId, jobPostingId }).select('status').lean()
      return winner ? { status: winner.status, created: false, transitioned: false } : null
    }
    throw err
  }
}
