import { z } from 'zod'
import type { ClientSession } from 'mongoose'
import { inngest } from '@shared/services/inngest'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, JobApplication, JobPosting, JobPracticeEvidence } from '@shared/db/models'
import { completion } from '@shared/services/modelRouter'
import {
  AI_EXECUTION_PROVENANCE_SCHEMA_VERSION,
  answerScoringBindingHash,
  captureModelConfigSnapshot,
  isAnswerScoringReceipt,
  isModelExecutionProvenance,
  modelExecutionProvenanceOf,
  type AnswerScoringReceipt,
  type ModelExecutionProvenance,
} from '@shared/services/scoringProvenance'
import { logger } from '@shared/logger'
import { xrayHashOf } from '../services/xrayService'
import { practiceHandoffHashOf } from '../services/practiceHandoff'
import { jobPostingStateOf } from '../services/postingAccess'
import {
  ensurePracticeApplication,
  hasCompletedScoredPractice,
  isScorablePracticeEvaluation,
} from '../services/applicationService'
import {
  computeReadiness,
  STRENGTH_WEIGHT,
  type CurrentReadinessProvenance,
  type EvidenceRowLike,
} from '../config/readiness'
import {
  currentEvidenceProvenance,
  EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
  SCORING_PROVENANCE_CONTRACTS,
} from '../services/evidenceProvenance'
export { EVIDENCE_ATTRIBUTION_CONTRACT_VERSION } from '../services/evidenceProvenance'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

/**
 * Per-answer → must-have attribution worker (READINESS.md §1, PR-R1).
 * Three steps so retries never re-bill the LLM (the memoized llm-attribute
 * output survives persist retries): load-inputs-provenance-v1 →
 * llm-attribute-provenance-v1 → persist.
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

export const EVIDENCE_ATTRIBUTION_SYSTEM_PROMPT =
  'You are a precise evidence-attribution classifier. Output only the requested JSON.'

const MAX_ATTRIBUTION_GROUPS = 40

const ATTRIBUTION_GROUP_SCHEMA = z.object({
  answerIndex: z.number().int().min(0),
  requirementIds: z.array(z.string().min(1).max(120)).max(6),
  strength: z.enum(['strong', 'partial', 'none']),
}).superRefine((group, ctx) => {
  if (group.strength === 'none' && group.requirementIds.length !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requirementIds'],
      message: 'none strength must use an empty requirement list',
    })
  }
  if (group.strength !== 'none' && group.requirementIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requirementIds'],
      message: 'evidence strength requires at least one requirement id',
    })
  }
})

const ATTRIBUTION_SCHEMA = z.object({
  attributions: z
    .array(ATTRIBUTION_GROUP_SCHEMA)
    .max(MAX_ATTRIBUTION_GROUPS),
})

export type EvidenceAttributionPayload = z.infer<typeof ATTRIBUTION_SCHEMA>

export interface EvidenceAttributionAttempt {
  model: string
  provider: string
  usedFallback: boolean
  truncated: boolean
  inputTokens: number
  outputTokens: number
}

export type EvidenceAttributionClassification = EvidenceAttributionPayload & {
  attempts: EvidenceAttributionAttempt[]
  provenance: ModelExecutionProvenance
}

export type EvidenceAttributionFailureReason =
  | 'invalid-input'
  | 'completion-failed'
  | 'truncated'
  | 'invalid-response'
  | 'config-drift'

/** Safe classifier failure: no prompt, answer, requirement, or raw model text. */
export class EvidenceAttributionClassificationError extends Error {
  readonly reason: EvidenceAttributionFailureReason
  readonly attempts: EvidenceAttributionAttempt[]

  constructor(
    reason: EvidenceAttributionFailureReason,
    message: string,
    attempts: EvidenceAttributionAttempt[] = [],
  ) {
    super(message)
    this.name = 'EvidenceAttributionClassificationError'
    this.reason = reason
    this.attempts = attempts.map((attempt) => ({ ...attempt }))
  }
}

interface LoadedInputs {
  outcome:
    | 'ok'
    | 'no-jd'
    | 'jd-version-mismatch' // TRANSIENT: posting cache may be stale — never stamped
    | 'no-scorable-answers'
    | 'duplicate-scorable-evaluations'
    | 'no-attested-scorable-answers'
    | 'no-parse' // TRANSIENT: X-ray parse not cached yet — never stamped
    | 'no-must-haves' // terminal: parse exists but lists zero must-haves
    | 'missing-context'
    | 'identity-mismatch' // TRANSIENT: canonical sweep repairs stale ids
    | 'not-scored' // TRANSIENT: feedback persistence must win before attribution
    | 'already-processed'
    | 'posting-restricted' // safety/legal closure: never derive new evidence
  answers: Array<{
    index: number
    question: string
    answer: string
    answerScore: number
    scoring: ModelExecutionProvenance
  }>
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
- For an answer with no evidence, output exactly {"answerIndex":n,"requirementIds":[],"strength":"none"}. Strong/partial groups require at least one listed id.

<job_must_have_requirements>
${reqLines}
</job_must_have_requirements>

<interview_answers>
${ansLines}
</interview_answers>`
}

/** Parse the production response contract, tolerating provider code fences or
 * short prose wrapped around the single JSON object. */
export function parseEvidenceAttributionResponse(text: string): EvidenceAttributionPayload {
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart < 0 || objectEnd < objectStart) {
    throw new Error('attribution response does not contain a JSON object')
  }
  return ATTRIBUTION_SCHEMA.parse(JSON.parse(text.slice(objectStart, objectEnd + 1)))
}

function validateAttributionInput(answers: LoadedInputs['answers']): Set<number> {
  if (answers.length === 0) {
    throw new EvidenceAttributionClassificationError(
      'invalid-input',
      'attribution requires at least one answer',
    )
  }
  if (answers.length > MAX_ATTRIBUTION_GROUPS) {
    throw new EvidenceAttributionClassificationError(
      'invalid-input',
      `attribution v1 supports at most ${MAX_ATTRIBUTION_GROUPS} answers per response`,
    )
  }
  const answerIndices = new Set<number>()
  for (const answer of answers) {
    if (answerIndices.has(answer.index)) {
      throw new EvidenceAttributionClassificationError(
        'invalid-input',
        'attribution answer indices must be unique',
      )
    }
    answerIndices.add(answer.index)
  }
  return answerIndices
}

function validateAttributionOutput(
  payload: EvidenceAttributionPayload,
  answerIndices: Set<number>,
): void {
  const classifiedAnswers = new Set<number>()
  const pairs = new Set<string>()
  for (const attribution of payload.attributions) {
    if (!answerIndices.has(attribution.answerIndex)) {
      throw new Error('attribution response contains an unknown answer index')
    }
    // v1 assigns one depth to every requirement grouped under an answer.
    // Repeating the answer with another depth would silently create a
    // pair-level contract that v1 has not versioned or persisted.
    if (classifiedAnswers.has(attribution.answerIndex)) {
      throw new Error('attribution response contains more than one strength group for an answer')
    }
    classifiedAnswers.add(attribution.answerIndex)
    for (const requirementId of attribution.requirementIds) {
      const pair = `${attribution.answerIndex}\u0000${requirementId}`
      if (pairs.has(pair)) {
        throw new Error('attribution response contains a duplicate answer-requirement pair')
      }
      pairs.add(pair)
    }
  }
  if (classifiedAnswers.size !== answerIndices.size) {
    throw new Error('attribution response does not classify every answer index')
  }
}

/**
 * Production-faithful classifier shared by the worker and the golden-set
 * harness. Its return keeps `attributions` at the top level so already
 * memoized Inngest step output remains structurally backward compatible.
 */
export async function classifyEvidenceAttribution(input: {
  answers: LoadedInputs['answers']
  mustHaves: LoadedInputs['mustHaves']
  beforeProviderCall?: () => Promise<boolean>
}): Promise<EvidenceAttributionClassification> {
  const answerIndices = validateAttributionInput(input.answers)
  const configBefore = await captureModelConfigSnapshot(
    'jobs.evidence-attribution',
    { waitForAuthoritative: true },
  ).catch(() => {
    throw new EvidenceAttributionClassificationError(
      'config-drift',
      'authoritative attribution config could not be resolved',
    )
  })
  if (!configBefore.authoritative) {
    throw new EvidenceAttributionClassificationError(
      'config-drift',
      'authoritative attribution config is unavailable',
    )
  }
  const activeSlot = configBefore.resolved
  const prompt = buildAttributionPrompt(input.answers, input.mustHaves)
  const attempts: EvidenceAttributionAttempt[] = []

  // G.3 truncation pattern: one retry at a bumped output-token budget.
  for (const bump of [0, 600]) {
    let response: Awaited<ReturnType<typeof completion>>
    try {
      response = await completion({
        taskSlot: 'jobs.evidence-attribution',
        system: EVIDENCE_ATTRIBUTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        ...(bump ? { maxTokens: activeSlot.maxTokens + bump } : {}),
        resolvedModel: activeSlot,
        beforeProviderCall: input.beforeProviderCall,
      })
    } catch (error) {
      // This named authority error controls a worker outcome and must retain
      // its exact identity; every other provider failure is sanitized.
      if (error instanceof Error && error.name === 'ModelProviderPreconditionError') throw error
      throw new EvidenceAttributionClassificationError(
        'completion-failed',
        'attribution completion failed',
        attempts,
      )
    }
    attempts.push({
      model: response.model,
      provider: response.provider,
      usedFallback: response.usedFallback,
      truncated: response.truncated === true,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    })

    // A truncated response can contain valid JSON with missing tail answers.
    // Never accept that partial classification as durable evidence.
    if (response.truncated) {
      if (bump) {
        throw new EvidenceAttributionClassificationError(
          'truncated',
          'attribution truncated after bumped retry',
          attempts,
        )
      }
      continue
    }
    try {
      const payload = parseEvidenceAttributionResponse(response.text)
      validateAttributionOutput(payload, answerIndices)
      return {
        ...payload,
        attempts,
        provenance: modelExecutionProvenanceOf({
          snapshot: configBefore,
          result: response,
          contractVersion: EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
          ...(bump ? { overrides: { maxTokens: activeSlot.maxTokens + bump } } : {}),
        }),
      }
    } catch (error) {
      if (error instanceof EvidenceAttributionClassificationError) throw error
      if (bump) {
        throw new EvidenceAttributionClassificationError(
          'invalid-response',
          'attribution parse failed after bumped retry',
          attempts,
        )
      }
    }
  }
  throw new Error('unreachable')
}

/** Terminal-outcome marker (Codex #538): row existence cannot signal
 *  "processed" — a session whose answers all came back 'none' stores zero
 *  rows yet is fully processed, and the sweep would re-emit (re-billing
 *  the LLM) every day for a week. Session missing = no-op update. */
async function markEvidenceProcessed(
  sessionId: string,
  dbSession?: ClientSession,
  unsupportedContract?: string,
): Promise<boolean> {
  const write = await InterviewSession.updateOne(
    { _id: sessionId },
    {
      $set: {
        'attribution.evidenceProcessedAt': new Date(),
        ...(unsupportedContract
          ? { 'attribution.evidenceUnsupportedContract': unsupportedContract }
          : {}),
      },
    },
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
  current: CurrentReadinessProvenance
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
      .select('requirementId xrayHash strength answerScore scoringEpoch sessionId provenance')
    if (dbSession) allRowsQuery.session(dbSession)
    const allRows = await allRowsQuery.lean()
    const snapshot = {
      ...computeReadiness(
        allRows.map((row) => ({ ...row, sessionId: String(row.sessionId) })) as unknown as EvidenceRowLike[],
        { xrayHash: input.xrayHash, mustHaveIds: input.mustHaveIds },
        input.current,
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

  const inputs = await step.run('load-inputs-provenance-v1', async (): Promise<LoadedInputs> => {
    const none = (outcome: LoadedInputs['outcome']): LoadedInputs => ({
      outcome, answers: [], mustHaves: [], xrayHash: '', handoffJdHash: '', applicationId, userId: '',
    })
    const [session, application, posting] = await Promise.all([
      InterviewSession.findById(sessionId).select(
        'config evaluations answerScoringReceipts userId jobDescription attribution status feedback',
      ).lean(),
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

    // Scorable answers only (panel R13): failed/truncated excluded. Every
    // answer must also have one unambiguous server-owned scoring receipt
    // hash-bound to the exact fields consumed below. Historical rows and
    // browser-forged evaluation metadata are never assigned today's model.
    const scorable = evals
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isScorablePracticeEvaluation(e))
    if (scorable.length === 0) return none('no-scorable-answers')

    // A receipt attests scored CONTENT, not an evaluation array position.
    // Reusing one content-bound receipt for duplicate copies would make a
    // single model execution look like multiple independently scored answers.
    // Fail the whole session closed instead of counting the unique remainder.
    const scorableBindings = scorable.map(({ e }) => answerScoringBindingHash(e))
    if (new Set(scorableBindings).size !== scorableBindings.length) {
      return none('duplicate-scorable-evaluations')
    }

    const receipts = ((session as { answerScoringReceipts?: unknown[] }).answerScoringReceipts ?? [])
      .filter(isAnswerScoringReceipt) as AnswerScoringReceipt[]
    const executionsByBinding = new Map<string, Map<string, ModelExecutionProvenance>>()
    for (const receipt of receipts) {
      const isKnownScorer = SCORING_PROVENANCE_CONTRACTS.some(
        ([taskSlot, contractVersion]) =>
          receipt.execution.taskSlot === taskSlot && receipt.execution.contractVersion === contractVersion,
      )
      if (!isKnownScorer) continue
      const byFingerprint = executionsByBinding.get(receipt.bindingHash) ?? new Map()
      byFingerprint.set(receipt.execution.fingerprint, receipt.execution)
      executionsByBinding.set(receipt.bindingHash, byFingerprint)
    }

    const answers = scorable.flatMap(({ e, i }) => {
      const executions = executionsByBinding.get(answerScoringBindingHash(e))
      // Multiple distinct receipts for identical scored content cannot prove
      // which execution produced the persisted evaluation. Quarantine that
      // answer instead of guessing from receipt order or current CMS config.
      if (!executions || executions.size !== 1) return []
      const scoring = executions.values().next().value as ModelExecutionProvenance
      return [{
        index: i,
        question: String(e.question ?? '').slice(0, 500),
        answer: String(e.answer ?? '').slice(0, 2000),
        answerScore: Math.round(
          ((Number(e.relevance) || 0) + (Number(e.structure) || 0) + (Number(e.specificity) || 0) + (Number(e.ownership) || 0)) / 4
        ),
        scoring,
      }]
    })
    if (answers.length === 0) return none('no-attested-scorable-answers')
    if (answers.length !== scorable.length) {
      logger.warn(
        { sessionId, droppedAnswers: scorable.length - answers.length },
        'scorable answers without unambiguous scoring receipts were excluded',
      )
    }

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

  // Durable steps serialize thrown errors and do not preserve custom fields.
  // Detect the known v1 support bound before entering `llm-attribute` so the
  // versioned terminal marker is guaranteed to run in its own durable step.
  if (inputs.answers.length > MAX_ATTRIBUTION_GROUPS) {
    await step.run('mark-unsupported-contract', () => markEvidenceProcessed(
      sessionId,
      undefined,
      EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
    ))
    logger.warn({ sessionId }, 'evidence attribution input exceeds v1 contract')
    return { outcome: 'unsupported-input' }
  }

  let verdicts: EvidenceAttributionClassification
  try {
    verdicts = await step.run('llm-attribute-provenance-v1', () => classifyEvidenceAttribution({
      answers: inputs.answers,
      mustHaves: inputs.mustHaves,
      beforeProviderCall: () => evidenceAuthorityIsCurrent(inputs, {
        sessionId,
        applicationId,
        jobPostingId,
      }),
    }))
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
  if (
    !isModelExecutionProvenance(verdicts.provenance) ||
    verdicts.provenance.taskSlot !== 'jobs.evidence-attribution' ||
    verdicts.provenance.contractVersion !== EVIDENCE_ATTRIBUTION_CONTRACT_VERSION
  ) {
    await step.run('mark-unsupported-provenance', () => markEvidenceProcessed(
      sessionId,
      undefined,
      'evidence-provenance.v1',
    ))
    logger.warn({ sessionId }, 'memoized attribution output lacks attested execution provenance')
    return { outcome: 'unsupported-provenance' }
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
    const current = await currentEvidenceProvenance()
    // Model-config resolution can cross an async cache boundary. Recheck after it
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
    const currentScoring = new Set(current.scoring.map((execution) => execution.fingerprint))
    const currentAttribution = new Set(current.attribution.map((execution) => execution.fingerprint))
    const attributionIsCurrent = currentAttribution.has(verdicts.provenance.fingerprint)
    const bestByReq = new Map<string, {
      doc: Record<string, unknown>
      score: number
      countable: boolean
    }>()
    for (const att of verdicts.attributions) {
      if (att.strength === 'none') continue
      const answer = byIndex.get(att.answerIndex)
      if (!answer) continue
      for (const reqId of att.requirementIds) {
        // The must-have belt (Codex #537): ids outside the given set are
        // dropped — the numerator's universe equals the denominator's.
        if (!mustHaveIds.has(reqId)) continue
        const score = STRENGTH_WEIGHT[att.strength] * answer.answerScore
        const countable = attributionIsCurrent && currentScoring.has(answer.scoring.fingerprint)
        const prev = bestByReq.get(reqId)
        if (
          prev && (
            (prev.countable && !countable) ||
            (prev.countable === countable && prev.score >= score)
          )
        ) continue
        bestByReq.set(reqId, {
          score,
          countable,
          doc: {
            sessionId, applicationId, jobPostingId,
            handoffVersion: 1,
            handoffJdHash: inputs.handoffJdHash,
            requirementId: reqId,
            xrayHash: inputs.xrayHash,
            strength: att.strength,
            answerScore: answer.answerScore,
            scoringEpoch: answer.scoring.fingerprint,
            provenance: {
              schemaVersion: AI_EXECUTION_PROVENANCE_SCHEMA_VERSION,
              status: 'attested',
              scoring: answer.scoring,
              attribution: verdicts.provenance,
            },
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
          const insertDocs = docs.map((d) => ({ ...d, userId: app.userId }))
          const inserted = await JobPracticeEvidence.insertMany(
            insertDocs,
            { ordered: true, session: dbSession },
          )
          if (inserted.length !== insertDocs.length) {
            throw new Error('verified evidence insert did not persist the complete replacement set')
          }
        }

        const readinessWritten = await writeVerifiedReadinessSnapshot({
          sessionId,
          applicationId,
          userId: String(app.userId),
          jobPostingId,
          xrayHash: inputs.xrayHash,
          handoffJdHash: inputs.handoffJdHash,
          mustHaveIds: inputs.mustHaves.map((mustHave) => mustHave.id),
          current,
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
 *  existence is intentionally ignored because rows from an older deployment
 *  may be partial and cannot prove readiness was fully materialized. Capped
 *  per run. */
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
        // Row existence from an older deployment cannot prove its replacement
        // set was complete. Re-run attribution for every eligible unstamped session;
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
