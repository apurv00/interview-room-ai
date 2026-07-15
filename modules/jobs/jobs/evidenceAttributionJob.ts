import { z } from 'zod'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, JobApplication, JobPosting, JobPracticeEvidence } from '@shared/db/models'
import { completion } from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'
import { logger } from '@shared/logger'
import { xrayHashOf } from '../services/xrayService'
import { computeReadiness, type EvidenceRowLike } from '../config/readiness'

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
    | 'no-parse'
    | 'missing-context'
  answers: Array<{ index: number; question: string; answer: string; answerScore: number; scoringEpoch: string }>
  mustHaves: Array<{ id: string; requirement: string }>
  xrayHash: string
  applicationId: string
  totalSessions: number
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

export async function runEvidenceAttributionHandler(
  event: { data: { sessionId: string; applicationId: string; jobPostingId: string } },
  step: StepRunner
): Promise<{ outcome: string; rows?: number }> {
  await connectDB()
  const { sessionId, applicationId, jobPostingId } = event.data

  const inputs = await step.run('load-inputs', async (): Promise<LoadedInputs> => {
    const none = (outcome: LoadedInputs['outcome']): LoadedInputs => ({
      outcome, answers: [], mustHaves: [], xrayHash: '', applicationId, totalSessions: 0,
    })
    const [session, application, posting] = await Promise.all([
      InterviewSession.findById(sessionId).select('config evaluations userId').lean(),
      JobApplication.findById(applicationId).select('practiceSessionIds userId').lean(),
      JobPosting.findById(jobPostingId).select('parsedJD parsedJDHash').lean(),
    ])
    if (!session || !application) return none('missing-context')
    const jd = (session.config as { jobDescription?: string } | undefined)?.jobDescription
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
    if (mustHaves.length === 0) return none('no-parse')

    // Scorable answers only (panel R13): failed/truncated excluded;
    // answerScore = round(mean of the 4 universal dims), recomputed here;
    // epoch = the evaluation's judge model.
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
        scoringEpoch: typeof e.modelUsed === 'string' && e.modelUsed ? e.modelUsed : 'unknown',
      }))
    if (answers.length === 0) return none('no-scorable-answers')

    return {
      outcome: 'ok',
      answers,
      mustHaves,
      xrayHash: sessionHash,
      applicationId,
      totalSessions: application.practiceSessionIds?.length ?? 0,
    }
  })
  if (inputs.outcome !== 'ok') {
    logger.info({ sessionId, outcome: inputs.outcome }, 'evidence attribution skipped')
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
    const mustHaveIds = new Set(inputs.mustHaves.map((m) => m.id))
    const byIndex = new Map(inputs.answers.map((a) => [a.index, a]))
    const docs: Array<Record<string, unknown>> = []
    for (const att of verdicts.attributions) {
      if (att.strength === 'none') continue
      const answer = byIndex.get(att.answerIndex)
      if (!answer) continue
      for (const reqId of att.requirementIds) {
        // The must-have belt (Codex #537): ids outside the given set are
        // dropped — the numerator's universe equals the denominator's.
        if (!mustHaveIds.has(reqId)) continue
        docs.push({
          sessionId, applicationId, jobPostingId,
          requirementId: reqId,
          xrayHash: inputs.xrayHash,
          strength: att.strength,
          answerScore: answer.answerScore,
          scoringEpoch: answer.scoringEpoch,
          at: new Date(),
        })
      }
    }
    const app = await JobApplication.findById(applicationId).select('userId practiceSessionIds').lean()
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
    // recompute. Epoch filter = the evaluate-answer slot's current model.
    const allRows = await JobPracticeEvidence.find({ applicationId })
      .select('requirementId xrayHash strength answerScore scoringEpoch sessionId')
      .lean()
    const snapshot = computeReadiness(
      allRows.map((r) => ({ ...r, sessionId: String(r.sessionId) })) as unknown as EvidenceRowLike[],
      { xrayHash: inputs.xrayHash, mustHaveIds: inputs.mustHaves.map((m) => m.id) },
      TASK_SLOT_DEFAULTS['interview.evaluate-answer'].model,
      app.practiceSessionIds?.length ?? 0
    )
    await JobApplication.updateOne({ _id: applicationId }, { $set: { readiness: snapshot } })
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
