import { gunzipSync } from 'zlib'
import { isValidObjectId, type ClientSession } from 'mongoose'
import { JobApplication, JobPosting, InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import { inngest } from '@shared/services/inngest'
import { getShortFormMinAnswers } from '@interview'
import { practiceHandoffHashOf } from './practiceHandoff'
import { xrayHashOf } from './xrayService'
import {
  exactOptionalPostingCondition,
  jobPostingStateOf,
} from './postingAccess'
import { MAX_JOB_TAILORED_TEXT_CHARS } from '@shared/jobsContract'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'
import { recordJobsUserEvent } from './userEventService'
import {
  canonicalApplyOptionsOf,
  resolveApplyOption,
  type CanonicalApplyOption,
} from './applyOptionIdentity'
import type { ApplyTier } from '../config/spamRules'
import {
  APPLY_OPEN_ATTEMPT_TTL_MS,
  BROKEN_LINK_REPORT_WINDOW_MS,
  linkDispositionOf,
  nextCrowdReportGovernance,
  normalizeExpiredCrowdIncident,
  withReplicatedLinkGovernance,
  type BrokenLinkDisposition,
} from './linkGovernance'

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

async function runApplicationTransaction<T>(
  userId: string,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return withActiveJobsAccountWrite(userId, work)
}

function exactApplyOptionPostingFilter(
  jobPostingId: string,
  posting: { status?: unknown; closedReason?: unknown },
  option: CanonicalApplyOption,
): Record<string, unknown> {
  return {
    _id: jobPostingId,
    status: posting.status,
    closedReason: exactOptionalPostingCondition(posting.closedReason),
    provenance: {
      $elemMatch: {
        sourceKey: option.sourceKey,
        applyUrl: option.storedUrl,
        applyTier: option.tier,
        applyUrlFirstSeenAt: exactOptionalPostingCondition(option.sourceApplyUrlFirstSeenAt),
      },
    },
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000
}

class ApplyOptionTransactionRaceError extends Error {}

// Provenance is capped at eight rungs. Keep twice that many distinct click
// ids/reports so ordinary option replacement retains useful history without
// letting repeated source churn grow an application document indefinitely.
const MAX_TRACKED_APPLY_OPTIONS = 16
const MAX_APPLY_OPEN_ATTEMPTS = 16
const MAX_BROKEN_LINK_REPORTS = 16

function boundedClickedOptionIds(
  existing: readonly string[] | null | undefined,
  optionId: string,
): string[] {
  return Array.from(new Set([...(existing ?? []).filter((id) => id !== optionId), optionId]))
    .slice(-MAX_TRACKED_APPLY_OPTIONS)
}

interface StoredBrokenLinkReport {
  optionId?: string
  url: string
  tier?: string
  reportedAt: Date
  subject?: string
  generation?: string
  incidentVersion?: number
  disposition?: BrokenLinkDisposition
}

interface StoredApplyOpenAttempt {
  optionId: string
  subject: string
  generation: string
  incidentVersion: number
  openedAt: Date
}

function boundedApplyOpenAttempts(
  existing: readonly StoredApplyOpenAttempt[] | null | undefined,
  next: StoredApplyOpenAttempt,
): StoredApplyOpenAttempt[] {
  return [
    ...(existing ?? []).filter((attempt) => !(
      attempt.subject === next.subject &&
      attempt.generation === next.generation &&
      attempt.incidentVersion === next.incidentVersion
    )),
    next,
  ].slice(-MAX_APPLY_OPEN_ATTEMPTS)
}

function boundedBrokenLinkReports(
  existing: readonly StoredBrokenLinkReport[] | null | undefined,
  next: StoredBrokenLinkReport,
  currentIncidentKeys: ReadonlySet<string>,
): StoredBrokenLinkReport[] {
  const reports = [...(existing ?? []), next]
  const retainedCurrent: StoredBrokenLinkReport[] = []
  const retainedCurrentIds = new Set<string>()
  // Walk newest-first so malformed legacy duplicates cannot displace the
  // newest canonical report for a current rung.
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const report = reports[index]
    if (
      report.subject && report.generation && report.incidentVersion &&
      currentIncidentKeys.has(`${report.subject}:${report.generation}:${report.incidentVersion}`) &&
      !retainedCurrentIds.has(`${report.subject}:${report.generation}:${report.incidentVersion}`)
    ) {
      retainedCurrent.unshift(report)
      retainedCurrentIds.add(`${report.subject}:${report.generation}:${report.incidentVersion}`)
    }
  }
  const historicalBudget = Math.max(0, MAX_BROKEN_LINK_REPORTS - retainedCurrent.length)
  const historical = historicalBudget === 0
    ? []
    : reports
        .filter((report) => {
          const key = report.subject && report.generation && report.incidentVersion
            ? `${report.subject}:${report.generation}:${report.incidentVersion}`
            : null
          return !key || !currentIncidentKeys.has(key)
        })
        .slice(-historicalBudget)
  return [...historical, ...retainedCurrent]
}

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
  let res
  try {
    res = await withActiveJobsAccountWrite(userId, (session) => JobApplication.updateOne(
      {
        userId,
        jobPostingId,
        $or: [{ atsRequestedAt: { $exists: false } }, { atsRequestedAt: { $lt: staleBefore } }],
      },
      { $set: { atsRequestedAt: now } },
      { session },
    ))
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) return { claimed: false, claimedAt: now }
    throw error
  }
  // claimedAt travels through the event: a superseded slow run may only
  // clear the marker IT set — never a newer run's (Codex on #521).
  return { claimed: (res?.modifiedCount ?? 0) === 1, claimedAt: now }
}

/** Rollback for a claim whose enqueue failed — the next click must work. */
export async function releaseAtsClaim(userId: string, jobPostingId: string): Promise<void> {
  await withActiveJobsAccountWrite(userId, (session) =>
    JobApplication.updateOne(
      { userId, jobPostingId },
      { $unset: { atsRequestedAt: 1 } },
      { session },
    ),
  ).catch(() => {})
}

class TailoredVersionTransactionRaceError extends Error {}

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
  | { ok: false; reason: 'not-found' | 'context-unavailable' | 'jd-mismatch' | 'invalid-payload' }
> {
  if (
    typeof payload.tailoredText !== 'string' ||
    !payload.tailoredText.trim() ||
    payload.tailoredText.length > MAX_JOB_TAILORED_TEXT_CHARS
  ) {
    return { ok: false, reason: 'invalid-payload' }
  }
  let retriedRace = false
  for (;;) {
    try {
      return await runApplicationTransaction(userId, async (session) => {
        const posting = await JobPosting.findById(jobPostingId, undefined, { session })
          .select('title company locations provenance status closedReason jdCompressed')
          .lean()
        if (!posting) return { ok: false, reason: 'not-found' as const }
        const postingState = jobPostingStateOf(posting)
        const existingApp = await JobApplication.findOne(
          { userId, jobPostingId },
          undefined,
          { session },
        ).select('_id').lean()
        // A closed id alone is not ownership proof. Preserve the same
        // not-found boundary as detail: only an existing application may
        // learn why its saved context cannot accept this artifact.
        if (postingState !== 'live' && !existingApp) {
          return { ok: false, reason: 'not-found' as const }
        }
        if (postingState === 'restricted') {
          return { ok: false, reason: 'context-unavailable' as const }
        }

        let canonicalJd = ''
        try {
          const buf = posting.jdCompressed as Buffer | undefined
          canonicalJd = buf?.length
            ? gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from((buf as { buffer: ArrayBufferLike }).buffer as ArrayBuffer)).toString('utf8')
            : ''
        } catch { /* unreadable canonical JD cannot prove Tailor provenance */ }
        if (!canonicalJd.trim()) {
          return { ok: false, reason: 'context-unavailable' as const }
        }
        if (payload.sourceJdHash !== practiceHandoffHashOf(canonicalJd)) {
          return { ok: false, reason: 'jd-mismatch' as const }
        }

        // The exact lifecycle/JD pin and application write share one Mongo
        // transaction. A merge, closure, or source revoke that wins cannot
        // leave a stale artifact or an orphan retention pin behind.
        const postingGuard = await JobPosting.updateOne(
          {
            _id: jobPostingId,
            status: posting.status,
            closedReason: exactOptionalPostingCondition(posting.closedReason),
            jdCompressed: posting.jdCompressed,
          },
          {
            $set: { userReferenced: true },
            $unset: { purgeAt: 1 },
            $inc: { derivedAuthorityRevision: 1 },
          },
          { session, timestamps: false },
        )
        if ((postingGuard?.matchedCount ?? 0) !== 1) {
          return { ok: false, reason: 'context-unavailable' as const }
        }

        // '' would fail the schema's string validation on create (Mongoose
        // treats empty as missing); paste/upload tailors have no source row.
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
            { session, runValidators: true },
          )
          if ((res?.matchedCount ?? 0) !== 1) {
            throw new TailoredVersionTransactionRaceError('application changed')
          }
          return { ok: true as const }
        }

        await JobApplication.create([{
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
        }], { session })
        return { ok: true as const }
      })
    } catch (error) {
      if (
        !retriedRace &&
        (isDuplicateKeyError(error) || error instanceof TailoredVersionTransactionRaceError)
      ) {
        retriedRace = true
        continue
      }
      if (error instanceof TailoredVersionTransactionRaceError) {
        return { ok: false, reason: 'context-unavailable' }
      }
      throw error
    }
  }
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
  const transition = await withActiveJobsAccountWrite(userId, async (session) => {
    // A target-status guard makes retries true no-ops: the original status
    // timestamp/history survive and telemetry below only sees a real edge.
    // `apply_clicked` is only evidence that a link opened, so it cannot jump
    // directly to the user-facing "No response" state without an `applied`
    // claim first.
    const prev = await JobApplication.findOneAndUpdate(
      {
        userId,
        jobPostingId,
        status: { $ne: to },
        ...(to === 'ghosted'
          ? {
              $or: [
                { status: { $in: ['applied', 'interview_scheduled', 'offer', 'rejected'] } },
                { appliedAt: { $type: 'date' } },
              ],
            }
          : {}),
      },
      {
        $set: { status: to, ...(to === 'applied' ? { appliedAt: now } : {}) },
        $push: { statusHistory: { status: to, at: now, source: 'user' } },
      },
      { new: false, session },
    )
    if (prev) return { changed: true as const, from: prev.status }

    // The conditional update cannot distinguish an idempotent retry from a
    // missing/forbidden row. Resolve that distinction in the same account
    // transaction so an already-satisfied request remains a successful no-op.
    const current = await JobApplication.findOne(
      { userId, jobPostingId },
      undefined,
      { session },
    ).select('status').lean()
    if (current?.status === to) {
      return { changed: false as const, from: current.status }
    }
    return null
  })
  if (!transition) return { ok: false }
  if (!transition.changed) return { ok: true, status: to, from: transition.from }

  // THE single emitter (EMAILS.md §4, Codex #530 R25): jobs.interview_scheduled
  // fires HERE on the edge (from != to) and nowhere else — the session-gated
  // status route and any token-gated email action are thin callers, so one
  // scheduled interview stays one event regardless of channel. Telemetry
  // never breaks the transition.
  if (telemetry) {
    try {
      const scheduledEdge = to === 'interview_scheduled'
      await recordJobsUserEvent({
        name: to === 'applied' ? 'jobs.apply_confirmed' : scheduledEdge ? 'jobs.interview_scheduled' : 'jobs.status_changed',
        userId,
        jobPostingId,
        props:
          to === 'applied'
            ? { latencyMs: telemetry.latencyMs, viaNudge: telemetry.viaNudge ?? false, from: transition.from, channel: telemetry.channel }
            : scheduledEdge
              ? { inferredFromPrep: telemetry.inferredFromPrep ?? false, from: transition.from, channel: telemetry.channel }
              : { from: transition.from, to, source: 'user', channel: telemetry.channel },
        ts: now,
      })
    } catch (err) {
      logger.warn({ err }, 'status telemetry write failed')
    }
  }
  return { ok: true, status: to, from: transition.from }
}

/** A report is advisory until either three distinct trusted openers agree in
 * one seven-day incident or the pinned machine checker independently fails. */
export type BrokenLinkResult =
  | {
      ok: true
      recorded: boolean
      optionId: string
      tier: ApplyTier
      hadFailover: boolean
      disposition: BrokenLinkDisposition
    }
  | { ok: false }

async function reportBrokenLinkAttempt(
  userId: string,
  jobPostingId: string,
  optionId: string,
  now: Date,
): Promise<BrokenLinkResult> {
  return runApplicationTransaction(userId, async (session) => {
    const posting = await JobPosting.findById(jobPostingId, undefined, { session })
      .select('provenance status closedReason linkCheckRequestedAt')
      .lean()
    // Archived links are historical context, not mutable crowd authority.
    if (!posting || jobPostingStateOf(posting) !== 'live') return { ok: false }

    const options = canonicalApplyOptionsOf(posting.provenance)
    const option = resolveApplyOption(posting.provenance, optionId)
    if (!option) return { ok: false }
    const hadFailover = options.length > 1
    const governance = option.governance
    if (
      governance.reportWindowStartedAt &&
      now.getTime() - governance.reportWindowStartedAt.getTime() >= BROKEN_LINK_REPORT_WINDOW_MS
    ) {
      // A fresh trusted open owns incident rollover. Never authorize against
      // one incident and write the report into another.
      return { ok: false }
    }

    const application = await JobApplication.findOne(
      { userId, jobPostingId },
      undefined,
      { session },
    ).select('applyOpenAttempts brokenLinkReports').lean()
    const openedAfter = new Date(now.getTime() - APPLY_OPEN_ATTEMPT_TTL_MS)
    const trustedAttempt = (application?.applyOpenAttempts ?? []).some((attempt) => (
      attempt.subject === option.subject &&
      attempt.generation === option.generation &&
      attempt.incidentVersion === option.incidentVersion &&
      new Date(attempt.openedAt).getTime() >= openedAfter.getTime() &&
      new Date(attempt.openedAt).getTime() <= now.getTime()
    ))
    if (!application || !trustedAttempt) {
      return { ok: false }
    }
    const alreadyReported = (application.brokenLinkReports ?? []).some((report) => (
      report.subject === option.subject &&
      report.generation === option.generation &&
      report.incidentVersion === option.incidentVersion
    ))
    if (alreadyReported) {
      return {
        ok: true,
        recorded: false,
        optionId,
        tier: option.tier,
        hadFailover,
        disposition: linkDispositionOf(governance),
      }
    }

    const nextGovernance = nextCrowdReportGovernance(governance, now)
    const disposition = linkDispositionOf(nextGovernance)
    const report = {
      optionId,
      url: option.url,
      tier: option.tier,
      reportedAt: now,
      subject: option.subject,
      generation: option.generation,
      incidentVersion: option.incidentVersion,
      disposition,
    }
    const boundedReports = boundedBrokenLinkReports(
      application.brokenLinkReports,
      report,
      new Set(options.map((candidate) => (
        `${candidate.subject}:${candidate.generation}:${candidate.incidentVersion}`
      ))),
    )
    const applicationWrite = await JobApplication.updateOne(
      {
        _id: application._id,
        userId,
        jobPostingId,
        applyOpenAttempts: {
          $elemMatch: {
            subject: option.subject,
            generation: option.generation,
            incidentVersion: option.incidentVersion,
            openedAt: { $gte: openedAfter, $lte: now },
          },
        },
        brokenLinkReports: {
          $not: {
            $elemMatch: {
              subject: option.subject,
              generation: option.generation,
              incidentVersion: option.incidentVersion,
            },
          },
        },
      },
      {
        $set: { brokenLinkReports: boundedReports },
      },
      { session },
    )
    if ((applicationWrite?.modifiedCount ?? 0) !== 1) {
      // Abort, rather than risk incrementing the shared rung without the
      // caller's unique report edge. A transaction retry will re-read a
      // concurrently committed duplicate and return idempotently.
      throw new ApplyOptionTransactionRaceError('application report edge changed')
    }

    const governedProvenance = withReplicatedLinkGovernance(
      posting.provenance,
      option.subject,
      nextGovernance,
    )
    const postingWrite = await JobPosting.updateOne(
      {
        _id: jobPostingId,
        status: posting.status,
        closedReason: exactOptionalPostingCondition(posting.closedReason),
        linkCheckRequestedAt: exactOptionalPostingCondition(posting.linkCheckRequestedAt),
        provenance: posting.provenance,
      },
      {
        $set: {
          provenance: governedProvenance,
          // One bounded priority signal per pending machine-check cycle.
          // Later reports/quorum never refresh it into an endless hot loop.
          ...(posting.linkCheckRequestedAt === undefined
            ? { linkCheckRequestedAt: now }
            : {}),
        },
      },
      { session, runValidators: true },
    )
    if ((postingWrite?.modifiedCount ?? 0) !== 1) {
      // The application write must roll back with the posting write. This is
      // the one global crowd-healing edge, so compensation is not sufficient.
      throw new ApplyOptionTransactionRaceError('posting option changed')
    }

    return {
      ok: true,
      recorded: true,
      optionId,
      tier: option.tier,
      hadFailover,
      disposition,
    }
  })
}

export async function reportBrokenLink(
  userId: string,
  jobPostingId: string,
  optionId: string,
  now = new Date(),
): Promise<BrokenLinkResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await reportBrokenLinkAttempt(userId, jobPostingId, optionId, now)
    } catch (error) {
      if (!(error instanceof ApplyOptionTransactionRaceError)) throw error
      if (attempt === 2) return { ok: false }
    }
  }
  return { ok: false }
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

  // Cheap fail-fast only. The transaction-bound User write below is the
  // durable account-deletion authority.
  if (!(await isJobsAccountActive(userId))) return null

  // applicationId originates in browser-held config and is advisory only.
  // The unique user+posting pair is the canonical identity and prevents a
  // stale, forged, or malformed application id from cross-attaching evidence.
  const filter = { userId, jobPostingId: attr.jobId }

  // jobId originates in browser-held config too. Bind it to the JD that the
  // server persisted on the session before mutating any posting/application;
  // malformed, stale, cross-job, missing, or corrupt bodies fail closed.
  const posting = await JobPosting.findById(attr.jobId)
    .select('title company locations provenance status closedReason jdCompressed')
    .lean()
  if (posting && jobPostingStateOf(posting) === 'restricted') return null
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
  const postingGuard = {
    _id: attr.jobId,
    status: posting.status,
    closedReason: exactOptionalPostingCondition(posting.closedReason),
    jdCompressed: posting.jdCompressed,
  }
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

  type PersistedPractice = {
    applicationId: string
    jobPostingId: string
    evidenceCount: number
    newlyAdded: boolean
  }
  let persisted: PersistedPractice | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      persisted = await withActiveJobsAccountWrite(userId, async (dbSession) => {
        // Session, exact posting pin, and ownership/evidence mutation share
        // the deletion fence. A stale JWT can never pin the posting first.
        const liveSession = await InterviewSession.findOne(
          sessionFilter,
          undefined,
          { session: dbSession },
        ).select('_id').lean()
        if (!liveSession) return null
        const pin = await JobPosting.updateOne(
          postingGuard,
          {
            $set: { userReferenced: true },
            $unset: { purgeAt: 1 },
            $inc: { derivedAuthorityRevision: 1 },
          },
          { session: dbSession, timestamps: false },
        )
        if ((pin?.matchedCount ?? 0) === 0) return null

        // The $ne predicate, not modifiedCount, proves this write inserted
        // the session. Timestamps can modify updatedAt on a no-op $addToSet.
        let newlyAdded = false
        const existingAttach = await JobApplication.updateOne(
          evidenceFilter,
          attach,
          { session: dbSession },
        )
        if ((existingAttach?.matchedCount ?? 0) > 0) {
          newlyAdded = true
        } else {
          const alreadyAttached = await JobApplication.findOne(
            { ...filter, verifiedPracticeSessionIds: session._id },
            undefined,
            { session: dbSession },
          ).select('_id').lean()
          if (!alreadyAttached) {
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
              {
                session: dbSession,
                upsert: true,
                setDefaultsOnInsert: true,
                runValidators: true,
              },
            )
            newlyAdded = (result?.upsertedCount ?? 0) > 0 || (result?.matchedCount ?? 0) > 0
          }
        }

        const app = await JobApplication.findOne(
          { ...filter, verifiedPracticeSessionIds: session._id },
          undefined,
          { session: dbSession },
        ).select('_id verifiedPracticeSessionIds jobPostingId').lean()
        if (!app) return null

        if (String(attr.applicationId ?? '') !== String(app._id)) {
          await InterviewSession.updateOne(
            {
              _id: session._id,
              userId,
              'attribution.source': 'jobs',
              'attribution.jobId': attr.jobId,
            },
            { $set: { 'attribution.applicationId': String(app._id) } },
            { session: dbSession },
          )
        }
        return {
          applicationId: String(app._id),
          jobPostingId: String(app.jobPostingId),
          evidenceCount: Math.min(3, app.verifiedPracticeSessionIds?.length ?? 0),
          newlyAdded,
        }
      })
      break
    } catch (error) {
      if (error instanceof JobsAccountInactiveError) return null
      if (attempt === 0 && isDuplicateKeyError(error)) continue
      throw error
    }
  }
  if (!persisted) return null

  // Single-session deletion does not mutate the account fence. Preserve the
  // existing post-commit compensation for that independent race; account
  // deletion itself is already ordered by the transaction above.
  const [sessionStillExists, accountStillActive, postingStillAuthorized] = await Promise.all([
    InterviewSession.findOne(sessionFilter).select('_id').lean(),
    isJobsAccountActive(userId),
    JobPosting.exists(postingGuard),
  ])
  if (!accountStillActive) return null
  if (!sessionStillExists || !postingStillAuthorized) {
    if (persisted.newlyAdded) {
      await withActiveJobsAccountWrite(userId, (dbSession) =>
        JobApplication.updateOne(
          {
            _id: persisted!.applicationId,
            ...filter,
            verifiedPracticeSessionIds: session._id,
          },
          {
            $pull: {
              practiceSessionIds: session._id,
              verifiedPracticeSessionIds: session._id,
            },
          },
          { session: dbSession },
        ),
      ).catch((error) => {
        if (!(error instanceof JobsAccountInactiveError)) throw error
      })
    }
    return null
  }

  return {
    ...persisted,
    sessionId: String(session._id),
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

  if (ensured.newlyAdded && await isJobsAccountActive(userId)) {
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
  /** Internal server-resolved metadata. Routes must never serialize this
   * object; `/open` uses only its safe URL for the immediate redirect. */
  canonicalOption: {
    optionId: string
    url: string
    tier: ApplyTier
    viaSite?: string
    subject: string
    generation: string
    incidentVersion: number
    broken: boolean
  }
}

async function recordApplyClickAttempt(
  userId: string,
  jobPostingId: string,
  optionId: string,
  now: Date,
  trustedOpen = false,
): Promise<ApplyClickResult | null> {
  return runApplicationTransaction(userId, async (session) => {
    const posting = await JobPosting.findById(jobPostingId, undefined, { session })
      .select('title company locations provenance status closedReason')
      .lean()
    if (!posting || (posting.status !== 'open' && posting.status !== 'closed')) return null
    const postingState = jobPostingStateOf(posting)
    if (postingState === 'restricted') return null
    const option = resolveApplyOption(posting.provenance, optionId)
    if (!option) return null
    // Only a live posting can mint a trusted external-open proof. The legacy
    // telemetry edge may still preserve an existing archived owner's status.
    if (trustedOpen && postingState !== 'live') return null

    const normalizedGovernance = trustedOpen
      ? normalizeExpiredCrowdIncident(option.governance, now)
      : option.governance
    const incidentRolled = normalizedGovernance.incidentVersion !== option.incidentVersion
    const authoritativeOption = incidentRolled
      ? {
          ...option,
          governance: normalizedGovernance,
          incidentVersion: normalizedGovernance.incidentVersion,
          broken: linkDispositionOf(normalizedGovernance) !== 'pending-verification',
        }
      : option

    const existing = await JobApplication.findOne(
      { userId, jobPostingId },
      undefined,
      { session },
    ).select('_id status clickedApplyOptionIds applyOpenAttempts').lean()
    // A first click may create ownership only while discovery is live. A
    // normal archive preserves an existing owner's in-flight canonical click,
    // but a closed id alone never manufactures ownership.
    if (!existing && postingState !== 'live') return null

    // The exact lifecycle + canonical provenance tuple is fenced in the same
    // transaction as the application write. A source revoke or option
    // replacement that wins forces a retry against the new truth.
    const pinnedProvenance = incidentRolled
      ? withReplicatedLinkGovernance(
          posting.provenance,
          authoritativeOption.subject,
          normalizedGovernance,
        )
      : null
    const pin = await JobPosting.updateOne(
      incidentRolled
        ? {
            _id: jobPostingId,
            status: posting.status,
            closedReason: exactOptionalPostingCondition(posting.closedReason),
            provenance: posting.provenance,
          }
        : exactApplyOptionPostingFilter(jobPostingId, posting, authoritativeOption),
      {
        $set: {
          userReferenced: true,
          ...(pinnedProvenance ? { provenance: pinnedProvenance } : {}),
        },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      { session, timestamps: false, ...(pinnedProvenance ? { runValidators: true } : {}) },
    )
    if ((pin?.matchedCount ?? 0) !== 1) return null

    const canonicalOption = {
      optionId: authoritativeOption.optionId,
      url: authoritativeOption.url,
      tier: authoritativeOption.tier,
      viaSite: authoritativeOption.viaSite,
      subject: authoritativeOption.subject,
      generation: authoritativeOption.generation,
      incidentVersion: authoritativeOption.incidentVersion,
      broken: authoritativeOption.broken,
    }
    const applyOpenAttempt: StoredApplyOpenAttempt | null = trustedOpen
      ? {
          optionId: authoritativeOption.optionId,
          subject: authoritativeOption.subject,
          generation: authoritativeOption.generation,
          incidentVersion: authoritativeOption.incidentVersion,
          openedAt: now,
        }
      : null
    if (existing) {
      const clickedApplyOptionIds = boundedClickedOptionIds(
        existing.clickedApplyOptionIds,
        authoritativeOption.optionId,
      )
      const applyOpenAttempts = applyOpenAttempt
        ? boundedApplyOpenAttempts(existing.applyOpenAttempts, applyOpenAttempt)
        : undefined
      if (existing.status !== 'saved') {
        const tracked = await JobApplication.updateOne(
          { _id: existing._id, userId, jobPostingId },
          {
            $set: {
              clickedApplyOptionIds,
              ...(applyOpenAttempts ? { applyOpenAttempts } : {}),
            },
          },
          { session },
        )
        if ((tracked?.matchedCount ?? 0) !== 1) {
          throw new ApplyOptionTransactionRaceError('application disappeared')
        }
        return {
          status: existing.status,
          created: false,
          transitioned: false,
          canonicalOption,
        }
      }
      const transitioned = await JobApplication.updateOne(
        { _id: existing._id, userId, jobPostingId, status: 'saved' },
        {
          $set: {
            status: 'apply_clicked',
            'jobSnapshot.applyTierAtClick': authoritativeOption.tier,
            'jobSnapshot.applyUrlAtClick': authoritativeOption.url,
            clickedApplyOptionIds,
            ...(applyOpenAttempts ? { applyOpenAttempts } : {}),
          },
          $push: { statusHistory: { status: 'apply_clicked', at: now, source: 'system' } },
        },
        { session },
      )
      if ((transitioned?.matchedCount ?? 0) === 1) {
        return {
          status: 'apply_clicked',
          created: false,
          transitioned: true,
          canonicalOption,
        }
      }
      throw new ApplyOptionTransactionRaceError('application status changed')
    }

    await JobApplication.create([{
      userId,
      jobPostingId,
      jobSnapshot: {
        title: posting.title,
        company: posting.company,
        location: (posting.locations ?? [])[0] ?? '',
        source: posting.provenance?.[0]?.sourceId ?? 'unknown',
        applyTierAtClick: authoritativeOption.tier,
        applyUrlAtClick: authoritativeOption.url,
      },
      status: 'apply_clicked',
      statusHistory: [{ status: 'apply_clicked', at: now, source: 'system' }],
      clickedApplyOptionIds: [authoritativeOption.optionId],
      ...(applyOpenAttempt ? { applyOpenAttempts: [applyOpenAttempt] } : {}),
    }], { session })
    return {
      status: 'apply_clicked',
      created: true,
      transitioned: true,
      canonicalOption,
    }
  })
}

export async function recordApplyClick(
  userId: string,
  jobPostingId: string,
  optionId: string,
  now = new Date(),
): Promise<ApplyClickResult | null> {
  // Two distinct writers may win in sequence: Save/Tailor/Practice can win
  // the create, then a forward status transition can win the first
  // convergence update. A third bounded attempt observes that settled status
  // and records only the canonical click id without regressing it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recordApplyClickAttempt(userId, jobPostingId, optionId, now)
    } catch (error) {
      const retryable = isDuplicateKeyError(error) ||
        error instanceof ApplyOptionTransactionRaceError
      if (!retryable) throw error
      if (attempt === 2) return null
    }
  }
  return null
}

/** Trusted navigation edge used only by `/open?intent=apply`. */
export async function recordApplyOpenAttempt(
  userId: string,
  jobPostingId: string,
  optionId: string,
  now = new Date(),
): Promise<ApplyClickResult | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recordApplyClickAttempt(userId, jobPostingId, optionId, now, true)
    } catch (error) {
      const retryable = isDuplicateKeyError(error) ||
        error instanceof ApplyOptionTransactionRaceError
      if (!retryable) throw error
      if (attempt === 2) return null
    }
  }
  return null
}
