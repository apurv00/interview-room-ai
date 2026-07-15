import { z } from 'zod'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, JobApplication, JobPosting, JobPracticeEvidence } from '@shared/db/models'
import { completion, resolveModel } from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'
import { logger } from '@shared/logger'
import { xrayHashOf } from '../services/xrayService'
import { computeReadiness, STRENGTH_WEIGHT, type EvidenceRowLike } from '../config/readiness'

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
    | 'jd-version-mismatch'
    | 'no-scorable-answers'
    | 'no-parse' // TRANSIENT: X-ray parse not cached yet — never stamped
    | 'no-must-haves' // terminal: parse exists but lists zero must-haves
    | 'missing-context'
  answers: Array<{ index: number; question: string; answer: string; answerScore: number }>
  mustHaves: Array<{ id: string; requirement: string }>
  xrayHash: string
  applicationId: string
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
async function markEvidenceProcessed(sessionId: string): Promise<void> {
  await InterviewSession.updateOne(
    { _id: sessionId },
    { $set: { 'attribution.evidenceProcessedAt': new Date() } }
  )
}

export async function runEvidenceAttributionHandler(
  event: { data: { sessionId: string; applicationId: string; jobPostingId: string } },
  step: StepRunner
): Promise<{ outcome: string; rows?: number }> {
  await connectDB()
  const { sessionId, applicationId, jobPostingId } = event.data

  const inputs = await step.run('load-inputs', async (): Promise<LoadedInputs> => {
    const none = (outcome: LoadedInputs['outcome']): LoadedInputs => ({
      outcome, answers: [], mustHaves: [], xrayHash: '', applicationId,
    })
    const [session, application, posting] = await Promise.all([
      InterviewSession.findById(sessionId).select('config evaluations userId jobDescription').lean(),
      JobApplication.findById(applicationId).select('userId').lean(),
      JobPosting.findById(jobPostingId).select('parsedJD parsedJDHash').lean(),
    ])
    if (!session || !application) return none('missing-context')
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
      .filter(({ e }) => (e.status ?? 'ok') === 'ok' && typeof e.answer === 'string' && (e.answer as string).trim())
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
      applicationId,
    }
  })
  if (inputs.outcome !== 'ok') {
    logger.info({ sessionId, outcome: inputs.outcome }, 'evidence attribution skipped')
    // Terminal skips are stamped so the daily sweep never re-emits them
    // (Codex #538). 'no-parse' stays UNSTAMPED — the posting's X-ray
    // parse lands whenever the detail page fetches /xray, so the sweep
    // must be able to retry it within its 7-day window (Codex #538 r3);
    // all skips exit before the LLM step, so re-emits cost no model spend.
    // Throw paths never stamp: Inngest retries are the path, the sweep
    // is the net.
    if (inputs.outcome !== 'no-parse') {
      await step.run('mark-processed', () => markEvidenceProcessed(sessionId))
    }
    return { outcome: inputs.outcome }
  }

  const verdicts = await step.run('llm-attribute', async () => {
    const prompt = buildAttributionPrompt(inputs.answers, inputs.mustHaves)
    // G.3 truncation pattern: one in-step retry at a bumped budget.
    for (const bump of [0, 600]) {
      const res = await completion({
        taskSlot: 'jobs.evidence-attribution',
        system: 'You are a precise evidence-attribution classifier. Output only the requested JSON.',
        messages: [{ role: 'user', content: prompt }],
        ...(bump ? { maxTokens: TASK_SLOT_DEFAULTS['jobs.evidence-attribution'].maxTokens + bump } : {}),
      })
      try {
        const jsonText = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1)
        return ATTRIBUTION_SCHEMA.parse(JSON.parse(jsonText))
      } catch (err) {
        if (bump) throw new Error(`attribution parse failed after bumped retry: ${(err as Error).message}`)
      }
    }
    throw new Error('unreachable')
  })

  const rows = await step.run('persist', async () => {
    // Delete-race guard: if the user GDPR-deleted this session between
    // llm-attribute and persist (a window Inngest backoff can stretch to
    // minutes), inserting would RESURRECT evidence the cascade removed
    // and re-write the snapshot the delete just unset. Abort untouched.
    const sessionAlive = await InterviewSession.exists({ _id: sessionId })
    if (!sessionAlive) {
      logger.warn({ sessionId }, 'session deleted mid-attribution — persist aborted')
      return 0
    }
    const epoch = await currentScoringEpoch()
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
    const app = await JobApplication.findById(applicationId).select('userId').lean()
    if (!app) return 0
    // Replace semantics per (session, hash): stale rows out, new set in —
    // the unique index makes duplicate delivery inert.
    await JobPracticeEvidence.deleteMany({ sessionId, xrayHash: inputs.xrayHash })
    if (docs.length) {
      await JobPracticeEvidence.insertMany(
        docs.map((d) => ({ ...d, userId: app.userId })),
        { ordered: false }
      ).catch((err) => {
        if ((err as { code?: number }).code !== 11000) throw err
      })
    }

    // Denormalize the readiness snapshot (panel R22) — consumers never
    // recompute. Epoch filter = the SAME epoch the rows above were
    // stamped with (currentScoringEpoch — single source, Codex #538 P1).
    const allRows = await JobPracticeEvidence.find({ applicationId })
      .select('requirementId xrayHash strength answerScore scoringEpoch sessionId')
      .lean()
    const snapshot = computeReadiness(
      allRows.map((r) => ({ ...r, sessionId: String(r.sessionId) })) as unknown as EvidenceRowLike[],
      { xrayHash: inputs.xrayHash, mustHaveIds: inputs.mustHaves.map((m) => m.id) },
      epoch
    )
    await JobApplication.updateOne({ _id: applicationId }, { $set: { readiness: snapshot } })
    // Zero stored rows (all 'none' / belt-dropped) is still PROCESSED —
    // without the marker the sweep re-emits and re-bills daily (Codex #538).
    await markEvidenceProcessed(sessionId)
    return docs.length
  })

  return { outcome: 'attributed', rows }
}

/** Reconciliation sweep (panel R14): jobs-attributed scored sessions from
 *  the last 7 days with no evidence rows get their event re-emitted —
 *  the awaited emit is the path, this is the net. Capped per run. */
export async function runEvidenceReconcileHandler(step: StepRunner): Promise<{ reEmitted: number }> {
  await connectDB()
  const candidates = await step.run('find-missing', async () => {
    const sessions = await InterviewSession.find({
      'attribution.source': 'jobs',
      // Processed sessions (including zero-evidence outcomes) are stamped
      // by the worker — the sweep only chases UNstamped ones (Codex #538).
      'attribution.evidenceProcessedAt': { $exists: false },
      createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) },
      'evaluations.0': { $exists: true },
    })
      .select('_id attribution userId')
      .limit(200)
      .lean()
    const out: Array<{ sessionId: string; applicationId: string; jobPostingId: string }> = []
    for (const s of sessions) {
      const attr = s.attribution as { jobId?: string; applicationId?: string } | undefined
      if (!attr?.jobId) continue
      // Legacy net: rows attributed before the stamp existed have no
      // evidenceProcessedAt — their evidence rows still mark them done.
      const has = await JobPracticeEvidence.exists({ sessionId: s._id })
      if (has) continue
      const app = attr.applicationId
        ? await JobApplication.findOne({ _id: attr.applicationId, userId: s.userId }).select('_id jobPostingId').lean()
        : await JobApplication.findOne({ userId: s.userId, jobPostingId: attr.jobId }).select('_id jobPostingId').lean()
      if (!app) continue
      out.push({ sessionId: String(s._id), applicationId: String(app._id), jobPostingId: String(app.jobPostingId) })
      if (out.length >= 50) break
    }
    return out
  })
  for (const c of candidates) {
    await inngest.send({ name: 'jobs/evidence.attribute', data: c })
  }
  return { reEmitted: candidates.length }
}

export const jobsEvidenceAttributionJob = inngest.createFunction(
  {
    id: 'jobs-evidence-attribution',
    name: 'Jobs: practice-evidence attribution',
    retries: 3, // covers the evaluations persist race; llm-attribute memoizes across persist retries
    concurrency: [{ limit: 2 }],
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
