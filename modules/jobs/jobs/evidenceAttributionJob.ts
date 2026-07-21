import { z } from 'zod'
import type { ClientSession } from 'mongoose'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, JobApplication, JobPosting, JobPracticeEvidence } from '@shared/db/models'
import { completion, resolveModel } from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'
import { logger } from '@shared/logger'
import { xrayHashOf } from '../services/xrayService'
import { practiceHandoffHashOf } from '../services/practiceHandoff'
import { jobPostingStateOf } from '../services/postingAccess'
import {
  ensurePracticeApplication,
  hasCompletedScoredPractice,
  isScorablePracticeEvaluation,
} from '../services/applicationService'
import { computeReadiness, STRENGTH_WEIGHT, type EvidenceRowLike } from '../config/readiness'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

/**
 * Per-answer → must-have attribution worker (READINESS.md §1, PR-R1).
 * Three steps so retries never re-bill the LLM (the memoized llm-attribute
 * output survives persist retries): load-inputs → llm-attribute → persist.
 *
 * Honesty invariants enforced here: failed/truncated evaluations are
 * excluded entirely; evidence binds to the JD VERSION the session actually
 * practiced against (hash mismatch = counted skip, never cross-version
 * attribution); returned ids outside the must-have set are dropped (the
 * numerator's universe equals the denominator's); 'none' verdicts are
 * never stored; parse-fail → retry, NEVER fabricated rows.
 */

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

/**
 * Scoring epoch (panel R8). AnswerEvaluation does NOT persist its judge
 * model — /api/evaluate-answer stamps `result.model` onto trackUsage only
 * (Codex #538 P1), so per-row `modelUsed` would be 'unknown' for every
 * live session and the snapshot's epoch filter would zero readiness
 * forever. Instead, rows are epoch-stamped with the evaluate-answer
 * slot's model AT ATTRIBUTION TIME, and the snapshot filter reads the
 * SAME expression — writer and reader cannot disagree. Attribution fires
 * seconds after the session persists, so this equals the judge model
 * except inside a model-cutover window (bounded mislabel, acceptable
 * for R1's purpose: detecting stale-epoch evidence after a cutover).
 *
 * RESOLVED, not hardcoded (Codex #538 round 2): an active CMS ModelConfig
 * row overrides TASK_SLOT_DEFAULTS for the actual evaluator, so the epoch
 * must go through the same resolveModel() path completion() uses — else a
 * CMS cutover would never make older evidence stale. Config is cached
 * in-memory (60s), so this is cheap per persist. Known bounded window:
 * on a cold process with empty config cache, resolveModel falls back to
 * defaults (it never throws) — under an active CMS override that run
 * stamps+filters with the default epoch (internally consistent, heals on
 * the next attribution). Accepted; prod has no CMS ModelConfig doc today.
 */
export async function currentScoringEpoch(): Promise<string> {
  const resolved = await resolveModel('interview.evaluate-answer')
  return resolved.model
}

const ATTRIBUTION_SCHEMA = z.object({
  attributions: z
    .array(
      z.object({
        answerIndex: z.number().int().min(0),
        requirementIds: z.array(z.string().min(1).max(120)).max(6),
        strength: z.enum(['strong', 'partial', 'none']),
      })
    )
    .max(40),
})

interface LoadedInputs {
  outcome:
    | 'ok'
    | 'no-jd'
    | 'jd-version-mismatch' // TRANSIENT: posting cache may be stale — never stamped
    | 'no-scorable-answers'
    | 'no-parse' // TRANSIENT: X-ray parse not cached yet — never stamped
    | 'no-must-haves' // terminal: parse exists but lists zero must-haves
    | 'missing-context'
    | 'identity-mismatch' // TRANSIENT: canonical sweep repairs stale ids
    | 'not-scored' // TRANSIENT: feedback persistence must win before attribution
    | 'already-processed'
    | 'posting-restricted' // safety/legal closure: never derive new evidence
  answers: Array<{ index: number; question: string; answer: string; answerScore: number }>
  mustHaves: Array<{ id: string; requirement: string }>
  xrayHash: string
  handoffJdHash: string
  applicationId: string
  userId: string
  postingStatus?: 'open' | 'closed'
  postingClosedReason?: string
}

function postingAuthorityFilter(
  inputs: LoadedInputs,
  jobPostingId: string,
): Record<string, unknown> | null {
  if (!inputs.postingStatus) return null
  return {
    _id: jobPostingId,
    status: inputs.postingStatus,
    closedReason: inputs.postingClosedReason
      ? inputs.postingClosedReason
      : { $exists: false },
    parsedJDHash: inputs.xrayHash,
  }
}

function sessionAuthorityFilter(
  inputs: LoadedInputs,
  event: { sessionId: string; jobPostingId: string },
): Record<string, unknown> {
  return {
    _id: event.sessionId,
    userId: inputs.userId,
    status: 'completed',
    feedback: { $exists: true },
    'attribution.source': 'jobs',
    'attribution.jobId': event.jobPostingId,
    'attribution.handoffVersion': 1,
    'attribution.jdHash': inputs.handoffJdHash,
    'attribution.evidenceProcessedAt': { $exists: false },
  }
}

function applicationAuthorityFilter(
  inputs: LoadedInputs,
  event: { sessionId: string; applicationId: string; jobPostingId: string },
): Record<string, unknown> {
  return {
    _id: event.applicationId,
    userId: inputs.userId,
    jobPostingId: event.jobPostingId,
    verifiedPracticeSessionIds: event.sessionId,
  }
}

/**
 * Exact durable authority for model egress and derived evidence writes.
 * The posting lifecycle/version, completed verified session, canonical
 * application membership, and surviving owner must all still match the
 * snapshots loaded for this run.
 */
async function evidenceAuthorityIsCurrent(
  inputs: LoadedInputs,
  event: { sessionId: string; applicationId: string; jobPostingId: string },
  dbSession?: ClientSession,
): Promise<boolean> {
  const postingFilter = postingAuthorityFilter(inputs, event.jobPostingId)
  if (!postingFilter) return false

  // MongoDB forbids parallel operations on a single transaction session.
  // The caller already acquired the active-User write fence, so serialize
  // the three remaining document authorities inside that snapshot.
  if (dbSession) {
    const posting = await JobPosting.exists(postingFilter).session(dbSession)
    if (!posting) return false
    const session = await InterviewSession.exists(sessionAuthorityFilter(inputs, event)).session(dbSession)
    if (!session) return false
    const application = await JobApplication.exists(applicationAuthorityFilter(inputs, event)).session(dbSession)
    return !!application
  }

  const postingQuery = JobPosting.exists(postingFilter)
  const interviewQuery = InterviewSession.exists(sessionAuthorityFilter(inputs, event))
  const applicationQuery = JobApplication.exists(applicationAuthorityFilter(inputs, event))
  const [posting, session, application, owner] = await Promise.all([
    postingQuery,
    interviewQuery,
    applicationQuery,
    isJobsAccountActive(inputs.userId),
  ])
  return !!posting && !!session && !!application && !!owner
}

export function buildAttributionPrompt(
  answers: LoadedInputs['answers'],
  mustHaves: LoadedInputs['mustHaves']
): string {
  const reqLines = mustHaves.map((r) => `- id: ${r.id} | ${r.requirement}`).join('\n')
  const ansLines = answers
    .map((a) => `[${a.index}] Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n')
  return `You map interview answers to the job requirements they gave evidence for.

Rules:
- strength is DEPTH of evidence for the requirement: "strong" = the answer directly demonstrates the requirement with specifics; "partial" = it touches the requirement without demonstrating it; "none" = no evidence. Judge evidence DEPTH only — answer quality is scored elsewhere.
- Attribute ONLY against the requirement ids listed. Never invent ids.
- An answer may evidence multiple requirements (rarely more than 3).
- Output JSON only: {"attributions":[{"answerIndex":number,"requirementIds":[string],"strength":"strong"|"partial"|"none"}]} — one entry per answer index given.

<job_must_have_requirements>
${reqLines}
</job_must_have_requirements>

<interview_answers>
${ansLines}
</interview_answers>`
}

/** Terminal-outcome marker (Codex #538): row existence cannot signal
 *  "processed" — a session whose answers all came back 'none' stores zero
 *  rows yet is fully processed, and the sweep would re-emit (re-billing
 *  the LLM) every day for a week. Session missing = no-op update. */
async function markEvidenceProcessed(sessionId: string, dbSession?: ClientSession): Promise<boolean> {
  const write = await InterviewSession.updateOne(
    { _id: sessionId },
    { $set: { 'attribution.evidenceProcessedAt': new Date() } },
    dbSession ? { session: dbSession } : undefined,
  )
  return (write?.matchedCount ?? 0) === 1
}

interface VerifiedReadinessInput {
  sessionId: string
  applicationId: string
  userId: string
  jobPostingId: string
  xrayHash: string
  handoffJdHash: string
  mustHaveIds: string[]
  epoch: string
}

/**
 * Rebuild readiness exclusively from server-verified v1 evidence. The
 * application membership predicate is both an ownership fence and a deletion
 * fence: a legacy/browser-attributed session can never surface a snapshot.
 */
async function writeVerifiedReadinessSnapshot(
  input: VerifiedReadinessInput,
  dbSession?: ClientSession,
): Promise<boolean> {
  const baseFilter = {
    _id: input.applicationId,
    userId: input.userId,
    jobPostingId: input.jobPostingId,
    verifiedPracticeSessionIds: input.sessionId,
  }
  // A snapshot is derived from a multi-document evidence read. Publish it
  // only if no other publisher or deletion invalidated that read; retrying
  // recomputes from the new durable set instead of overwriting newer truth.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const app = await JobApplication.findOne(baseFilter, undefined, dbSession ? { session: dbSession } : undefined)
      .select('readinessRevision')
      .lean()
    if (!app) return false
    const rawRevision = Number((app as { readinessRevision?: number }).readinessRevision ?? 0)
    const expectedRevision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0
    const allRowsQuery = JobPracticeEvidence.find({
      applicationId: input.applicationId,
      handoffVersion: 1,
      handoffJdHash: input.handoffJdHash,
    })
      .select('requirementId xrayHash strength answerScore scoringEpoch sessionId')
    if (dbSession) allRowsQuery.session(dbSession)
    const allRows = await allRowsQuery.lean()
    const snapshot = {
      ...computeReadiness(
        allRows.map((row) => ({ ...row, sessionId: String(row.sessionId) })) as unknown as EvidenceRowLike[],
        { xrayHash: input.xrayHash, mustHaveIds: input.mustHaveIds },
        input.epoch
      ),
      handoffVersion: 1 as const,
    }
    const revisionPredicate = expectedRevision === 0
      ? { $or: [{ readinessRevision: 0 }, { readinessRevision: { $exists: false } }] }
      : { readinessRevision: expectedRevision }
    const write = await JobApplication.updateOne(
      { ...baseFilter, ...revisionPredicate },
      {
        $set: { readiness: snapshot },
        $inc: { readinessRevision: 1 },
      },
      dbSession ? { session: dbSession } : undefined,
    )
    if ((write?.matchedCount ?? 0) > 0) return true
  }
  return false
}

export async function runEvidenceAttributionHandler(
  event: { data: { sessionId: string; applicationId: string; jobPostingId: string } },
  step: StepRunner
): Promise<{ outcome: string; rows?: number }> {
  await connectDB()
  const { sessionId, applicationId, jobPostingId } = event.data

  const inputs = await step.run('load-inputs', async (): Promise<LoadedInputs> => {
    const none = (outcome: LoadedInputs['outcome']): LoadedInputs => ({
      outcome, answers: [], mustHaves: [], xrayHash: '', handoffJdHash: '', applicationId, userId: '',
    })
    const [session, application, posting] = await Promise.all([
      InterviewSession.findById(sessionId).select('config evaluations userId jobDescription attribution status feedback').lean(),
      JobApplication.findById(applicationId).select('userId jobPostingId').lean(),
      JobPosting.findById(jobPostingId).select('status closedReason parsedJD parsedJDHash').lean(),
    ])
    if (!session || !application) return none('missing-context')
    const sessionAttr = session.attribution as {
      source?: string
      jobId?: string
      handoffVersion?: number
      jdHash?: string
      evidenceProcessedAt?: Date
    } | undefined
    if (
      sessionAttr?.source !== 'jobs' ||
      sessionAttr.handoffVersion !== 1 ||
      !sessionAttr.jdHash ||
      String(sessionAttr.jobId ?? '') !== String(jobPostingId) ||
      String(session.userId) !== String(application.userId) ||
      String(application.jobPostingId) !== String(jobPostingId)
    ) {
      return none('identity-mismatch')
    }
    // Event/function ids deduplicate for a bounded window. The persisted
    // marker is the permanent fence against a later duplicate re-billing
    // the model after that window expires.
    if (sessionAttr.evidenceProcessedAt) return none('already-processed')
    if (!hasCompletedScoredPractice(session)) return none('not-scored')
    // The JD lives TOP-LEVEL on InterviewSession — /api/interviews mirrors
    // it out of config because the strict config subdoc strips undeclared
    // keys (Codex #538 r3 P1: reading config.jobDescription meant every
    // live session landed no-jd). Config read kept as a legacy fallback.
    const jd =
      (session as { jobDescription?: string }).jobDescription ??
      (session.config as { jobDescription?: string } | undefined)?.jobDescription
    if (!jd) return none('no-jd')
    // Missing evaluations at rail-fire time is a persist race — throw so
    // Inngest retries with backoff (bounded by the function's retry cap).
    const evals = session.evaluations as unknown as Array<Record<string, unknown>> | undefined
    if (!evals || evals.length === 0) throw new Error('evaluations not yet persisted — retry')

    // JD-version binding (panel R23): evidence attaches to the JD the
    // session PRACTICED AGAINST. Mismatch with the posting's cached parse
    // = counted skip (never cross-version, never a second parse in v1).
    const sessionHash = xrayHashOf(jd)
    if (practiceHandoffHashOf(jd) !== sessionAttr.jdHash) return none('identity-mismatch')
    if (posting && jobPostingStateOf(posting) === 'restricted') {
      return none('posting-restricted')
    }
    if (!posting?.parsedJD || posting.parsedJDHash !== sessionHash) {
      return none(posting?.parsedJD ? 'jd-version-mismatch' : 'no-parse')
    }
    const requirements = (posting.parsedJD as { requirements?: Array<{ id?: string; requirement?: string; importance?: string }> }).requirements ?? []
    const mustHaves = requirements
      .filter((r) => r.importance === 'must-have' && r.id && r.requirement)
      .map((r) => ({ id: String(r.id), requirement: String(r.requirement).slice(0, 300) }))
    // Parse exists but lists no must-haves: terminal (first-write-wins
    // cache — the parse will not change under this hash), unlike the
    // transient missing-parse case above.
    if (mustHaves.length === 0) return none('no-must-haves')

    // Scorable answers only (panel R13): failed/truncated excluded;
    // answerScore = round(mean of the 4 universal dims), recomputed here.
    // Epoch is NOT read per-row — see currentScoringEpoch (Codex #538 P1).
    const answers = evals
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isScorablePracticeEvaluation(e))
      .map(({ e, i }) => ({
        index: i,
        question: String(e.question ?? '').slice(0, 500),
        answer: String(e.answer ?? '').slice(0, 2000),
        answerScore: Math.round(
          ((Number(e.relevance) || 0) + (Number(e.structure) || 0) + (Number(e.specificity) || 0) + (Number(e.ownership) || 0)) / 4
        ),
      }))
    if (answers.length === 0) return none('no-scorable-answers')

    return {
      outcome: 'ok',
      answers,
      mustHaves,
      xrayHash: sessionHash,
      handoffJdHash: sessionAttr.jdHash,
      applicationId,
      userId: String(session.userId),
      postingStatus: posting.status,
      postingClosedReason: posting.closedReason,
    }
  })
  if (inputs.outcome !== 'ok') {
    logger.info({ sessionId, outcome: inputs.outcome }, 'evidence attribution skipped')
    // Terminal skips are stamped so the daily sweep never re-emits them
    // (Codex #538). Two outcomes stay UNSTAMPED so the sweep can retry
    // them within its 7-day window (all skips exit before the LLM step,
    // so re-emits cost no model spend):
    // - 'no-parse': the X-ray parse lands whenever the detail page
    //   fetches /xray (r3);
    // - 'jd-version-mismatch': the posting cache may simply be STALE —
    //   a session practiced against the UPDATED JD looks mismatched
    //   until /xray reparses, after which the hashes align (r4). Genuine
    //   old-JD sessions churn the sweep for at most 7 days, then age out.
    // Throw paths never stamp: Inngest retries are the path, the sweep
    // is the net.
    if (
      inputs.outcome !== 'no-parse' &&
      inputs.outcome !== 'jd-version-mismatch' &&
      inputs.outcome !== 'missing-context' &&
      inputs.outcome !== 'identity-mismatch' &&
      inputs.outcome !== 'not-scored' &&
      inputs.outcome !== 'already-processed' &&
      inputs.outcome !== 'posting-restricted'
    ) {
      await step.run('mark-processed', () => markEvidenceProcessed(sessionId))
    }
    return { outcome: inputs.outcome }
  }

  let verdicts: z.infer<typeof ATTRIBUTION_SCHEMA>
  try {
    verdicts = await step.run('llm-attribute', async () => {
      const prompt = buildAttributionPrompt(inputs.answers, inputs.mustHaves)
      // G.3 truncation pattern: one in-step retry at a bumped budget.
      for (const bump of [0, 600]) {
        const res = await completion({
          taskSlot: 'jobs.evidence-attribution',
          system: 'You are a precise evidence-attribution classifier. Output only the requested JSON.',
          messages: [{ role: 'user', content: prompt }],
          ...(bump ? { maxTokens: TASK_SLOT_DEFAULTS['jobs.evidence-attribution'].maxTokens + bump } : {}),
          beforeProviderCall: () => evidenceAuthorityIsCurrent(inputs, {
            sessionId,
            applicationId,
            jobPostingId,
          }),
        })
        // A truncated response can still parse as VALID JSON with the tail
        // answers silently missing (the schema cannot require one entry per
        // answer) — accepting it would permanently undercount readiness for
        // this session (Codex #538 r4). Retry at the bumped budget; still
        // truncated → throw (Inngest retries, the sweep is the net).
        if (res.truncated) {
          if (bump) throw new Error('attribution truncated after bumped retry')
          continue
        }
        try {
          const jsonText = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1)
          return ATTRIBUTION_SCHEMA.parse(JSON.parse(jsonText))
        } catch (err) {
          if (bump) throw new Error(`attribution parse failed after bumped retry: ${(err as Error).message}`)
        }
      }
      throw new Error('unreachable')
    })
  } catch (err) {
    // modelRouter uses this named error for a denied/failed precondition and
    // must not reinterpret it as a provider failure eligible for fallback.
    // Inngest may rehydrate step errors, so match the stable name too.
    if (err instanceof Error && err.name === 'ModelProviderPreconditionError') {
      logger.warn({ sessionId }, 'posting/session authority revoked before evidence model call')
      return { outcome: 'authority-revoked' }
    }
    throw err
  }

  const rows = await step.run('persist', async () => {
    // Delete-race guard: if the user GDPR-deleted this session between
    // llm-attribute and persist (a window Inngest backoff can stretch to
    // minutes), inserting would RESURRECT evidence the cascade removed
    // and re-write the snapshot the delete just unset. Abort untouched.
    if (!(await evidenceAuthorityIsCurrent(inputs, { sessionId, applicationId, jobPostingId }))) {
      logger.warn({ sessionId }, 'posting/session authority changed mid-attribution — persist aborted')
      return 0
    }
    const epoch = await currentScoringEpoch()
    // resolveModel can cross an async config/cache boundary. Recheck after it
    // so a revocation that committed during epoch resolution cannot be
    // followed by a new evidence or readiness write.
    if (!(await evidenceAuthorityIsCurrent(inputs, { sessionId, applicationId, jobPostingId }))) {
      logger.warn({ sessionId }, 'posting/session authority changed before evidence persistence')
      return 0
    }
    const mustHaveIds = new Set(inputs.mustHaves.map((m) => m.id))
    const byIndex = new Map(inputs.answers.map((a) => [a.index, a]))
    // Two answers may evidence the SAME requirement; the unique index
    // {sessionId, requirementId, xrayHash} would then reject whichever
    // duplicate insertMany hits second — possibly the stronger one
    // (Codex #538). Collapse to the best row per requirement here, the
    // same best = strengthWeight × answerScore rule computeReadiness uses.
    const bestByReq = new Map<string, { doc: Record<string, unknown>; score: number }>()
    for (const att of verdicts.attributions) {
      if (att.strength === 'none') continue
      const answer = byIndex.get(att.answerIndex)
      if (!answer) continue
      for (const reqId of att.requirementIds) {
        // The must-have belt (Codex #537): ids outside the given set are
        // dropped — the numerator's universe equals the denominator's.
        if (!mustHaveIds.has(reqId)) continue
        const score = STRENGTH_WEIGHT[att.strength] * answer.answerScore
        const prev = bestByReq.get(reqId)
        if (prev && prev.score >= score) continue
        bestByReq.set(reqId, {
          score,
          doc: {
            sessionId, applicationId, jobPostingId,
            handoffVersion: 1,
            handoffJdHash: inputs.handoffJdHash,
            requirementId: reqId,
            xrayHash: inputs.xrayHash,
            strength: att.strength,
            answerScore: answer.answerScore,
            scoringEpoch: epoch,
            at: new Date(),
          },
        })
      }
    }
    const docs = Array.from(bestByReq.values()).map((b) => b.doc)
    try {
      return await withActiveJobsAccountWrite(inputs.userId, async (dbSession) => {
        // Recheck every authority inside the transaction that owns the User
        // deletion fence. Session deletion and readiness writes also touch
        // their canonical documents here, so partial evidence cannot survive
        // either deletion order.
        if (!(await evidenceAuthorityIsCurrent(
          inputs,
          { sessionId, applicationId, jobPostingId },
          dbSession,
        ))) return 0

        const exactPostingFilter = postingAuthorityFilter(inputs, jobPostingId)
        if (!exactPostingFilter) return 0
        const postingFence = await JobPosting.updateOne(
          exactPostingFilter,
          { $inc: { derivedAuthorityRevision: 1 } },
          { session: dbSession, timestamps: false },
        )
        if ((postingFence.matchedCount ?? 0) !== 1) return 0

        const app = await JobApplication.findOne(
          {
            _id: applicationId,
            userId: inputs.userId,
            jobPostingId,
            verifiedPracticeSessionIds: sessionId,
          },
          undefined,
          { session: dbSession },
        ).select('userId jobPostingId').lean()
        if (!app) return 0

        // Replace semantics per (session, hash): stale rows out, new set in.
        // Per-application Inngest concurrency serializes duplicate delivery;
        // any unexpected unique conflict aborts this whole transaction.
        await JobPracticeEvidence.deleteMany(
          { sessionId, xrayHash: inputs.xrayHash },
          { session: dbSession },
        )
        if (docs.length) {
          await JobPracticeEvidence.insertMany(
            docs.map((d) => ({ ...d, userId: app.userId })),
            { ordered: false, session: dbSession },
          )
        }

        const readinessWritten = await writeVerifiedReadinessSnapshot({
          sessionId,
          applicationId,
          userId: String(app.userId),
          jobPostingId,
          xrayHash: inputs.xrayHash,
          handoffJdHash: inputs.handoffJdHash,
          mustHaveIds: inputs.mustHaves.map((mustHave) => mustHave.id),
          epoch,
        }, dbSession)
        if (!readinessWritten) {
          throw new Error('verified readiness snapshot write missed canonical application')
        }

        // Zero stored rows (all 'none' / belt-dropped) is still PROCESSED.
        // This session write also serializes with single-session deletion.
        if (!(await markEvidenceProcessed(sessionId, dbSession))) {
          throw new Error('evidence session changed before processed marker commit')
        }
        return docs.length
      })
    } catch (error) {
      if (error instanceof JobsAccountInactiveError) {
        logger.warn({ sessionId }, 'account deletion fenced evidence persistence')
        return 0
      }
      throw error
    }
  })

  return { outcome: 'attributed', rows }
}

/** Reconciliation sweep (panel R14): eligible Jobs-attributed sessions from
 *  the last 7 days without the durable processed marker get re-emitted. Row
 *  existence is intentionally ignored because a partial unordered insert
 *  cannot prove that readiness was fully materialized. Capped per run. */
export async function runEvidenceReconcileHandler(step: StepRunner): Promise<{ reEmitted: number }> {
  await connectDB()
  const candidates = await step.run('find-missing', async () => {
    const out: Array<{ sessionId: string; applicationId: string; jobPostingId: string }> = []
    let afterId: unknown
    const pageSize = 200
    do {
      const filter: Record<string, unknown> = {
        'attribution.source': 'jobs',
        'attribution.handoffVersion': 1,
        // Processed sessions (including zero-evidence outcomes) are stamped
        // by the worker — the sweep only chases UNstamped ones (Codex #538).
        'attribution.evidenceProcessedAt': { $exists: false },
        status: 'completed',
        feedback: { $exists: true },
        createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) },
        // Push the type-aware minimum into Mongo so known short-form rows do
        // not occupy scan pages. The exact scorable-answer check stays below.
        $or: [
          {
            'config.interviewType': { $in: ['coding', 'system-design'] },
            'evaluations.0': { $exists: true },
          },
          {
            'config.interviewType': { $nin: ['coding', 'system-design'] },
            'evaluations.2': { $exists: true },
          },
        ],
      }
      if (afterId) filter._id = { $gt: afterId }
      const sessions = await InterviewSession.find(filter)
        .select('_id attribution userId evaluations status feedback config')
        .sort({ _id: 1 })
        .limit(pageSize)
        .lean()
      if (sessions.length === 0) break
      afterId = sessions[sessions.length - 1]._id

      for (const s of sessions) {
        const attr = s.attribution as { jobId?: string; jdHash?: string } | undefined
        if (!attr?.jobId || !attr.jdHash) continue
        // Completed-but-ineligible is terminal. Stamp it once so corrupt or
        // failed answer arrays cannot become a permanent sweep poison page.
        if (!hasCompletedScoredPractice(s)) {
          await markEvidenceProcessed(String(s._id))
          continue
        }
        const ensured = await ensurePracticeApplication(String(s.userId), String(s._id)).catch((err) => {
          logger.warn({ err, sessionId: s._id }, 'evidence reconciliation candidate failed')
          return null
        })
        if (!ensured) continue
        // Row existence cannot prove a previous unordered bulk insert was
        // complete. Re-run attribution for every eligible unstamped session;
        // the worker replaces that session's entire verified row set before
        // atomically publishing the snapshot and processed marker.
        out.push({
          sessionId: ensured.sessionId,
          applicationId: ensured.applicationId,
          jobPostingId: ensured.jobPostingId,
        })
        if (out.length >= 50) break
      }
      if (sessions.length < pageSize) break
    } while (out.length < 50)
    return out
  })
  for (const c of candidates) {
    await step.run(`emit-${c.sessionId}`, () =>
      inngest.send({ id: `jobs-evidence-${c.sessionId}`, name: 'jobs/evidence.attribute', data: c })
    )
  }
  return { reEmitted: candidates.length }
}

export const jobsEvidenceAttributionJob = inngest.createFunction(
  {
    id: 'jobs-evidence-attribution',
    name: 'Jobs: practice-evidence attribution',
    retries: 3, // covers the evaluations persist race; llm-attribute memoizes across persist retries
    idempotency: 'event.data.sessionId',
    concurrency: [
      { limit: 2 },
      { limit: 1, key: 'event.data.applicationId' },
    ],
    triggers: [{ event: 'jobs/evidence.attribute' }],
  },
  async ({ event, step }) =>
    runEvidenceAttributionHandler(event as unknown as { data: { sessionId: string; applicationId: string; jobPostingId: string } }, step as StepRunner)
)

export const jobsEvidenceReconcileJob = inngest.createFunction(
  {
    id: 'jobs-evidence-reconcile',
    name: 'Jobs: evidence reconciliation sweep',
    retries: 1,
    triggers: [{ cron: '20 2 * * *' }], // daily, off-peak
  },
  async ({ step }) => runEvidenceReconcileHandler(step as StepRunner)
)
