import { createHash } from 'node:crypto'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import {
  resolveModelWithAuthority,
  type CompletionResult,
  type ConfigLoadSource,
  type ResolvedModel,
} from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS, TASK_SLOTS, type TaskSlot } from '@shared/services/taskSlots'

export const AI_EXECUTION_PROVENANCE_SCHEMA_VERSION = 1 as const
export const ANSWER_SCORING_RECEIPT_SCHEMA_VERSION = 1 as const
export const ANSWER_EVALUATION_CONTRACT_VERSION = 'answer-evaluation.v1' as const
export const CODE_EVALUATION_CONTRACT_VERSION = 'code-evaluation.v1' as const
export const DESIGN_EVALUATION_CONTRACT_VERSION = 'design-evaluation.v1' as const

const MAX_JOBS_SCORING_RECEIPTS = 200

export interface ModelConfigSnapshot {
  taskSlot: TaskSlot
  resolved: ResolvedModel
  digest: string
  source: ConfigLoadSource | 'explicit'
  authoritative: boolean
}

export interface ModelExecutionProvenance {
  schemaVersion: typeof AI_EXECUTION_PROVENANCE_SCHEMA_VERSION
  taskSlot: TaskSlot
  contractVersion: string
  model: string
  provider: string
  usedFallback: boolean
  attemptKind: 'primary' | 'configured-fallback' | 'task-default'
  configDigest: string
  fingerprint: string
}

export interface AnswerScoringReceipt {
  schemaVersion: typeof ANSWER_SCORING_RECEIPT_SCHEMA_VERSION
  bindingHash: string
  execution: ModelExecutionProvenance
  recordedAt: Date
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeResolvedModel(resolved: ResolvedModel) {
  return {
    model: resolved.model,
    provider: resolved.provider,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature ?? null,
    reasoningEffort: resolved.reasoningEffort ?? null,
    fallbackModel: resolved.fallbackModel ?? null,
    fallbackProvider: resolved.fallbackProvider ?? null,
    useToonInput: resolved.useToonInput,
  }
}

export function modelConfigSnapshotOf(
  taskSlot: TaskSlot,
  resolved: ResolvedModel,
  authority: Pick<ModelConfigSnapshot, 'source' | 'authoritative'> = {
    source: 'explicit',
    authoritative: true,
  },
): ModelConfigSnapshot {
  const safe = safeResolvedModel(resolved)
  return {
    taskSlot,
    resolved: { ...resolved },
    digest: digest({ taskSlot, ...safe }),
    source: authority.source,
    authoritative: authority.authoritative,
  }
}

export async function captureModelConfigSnapshot(
  taskSlot: TaskSlot,
  options: { waitForAuthoritative?: boolean } = {},
): Promise<ModelConfigSnapshot> {
  const authority = await resolveModelWithAuthority(taskSlot, options)
  return modelConfigSnapshotOf(taskSlot, authority.resolved, authority)
}

export function sameModelConfigSnapshot(
  before: ModelConfigSnapshot,
  after: ModelConfigSnapshot,
): boolean {
  return before.authoritative && after.authoritative &&
    before.taskSlot === after.taskSlot && before.digest === after.digest
}

type ExecutionOverrides = {
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ResolvedModel['reasoningEffort']
}

function executionAttemptOf(
  snapshot: ModelConfigSnapshot,
  result: Pick<CompletionResult, 'model' | 'provider' | 'usedFallback' | 'attemptKind'>,
  overrides: ExecutionOverrides,
) {
  const { resolved, taskSlot } = snapshot
  const defaults = TASK_SLOT_DEFAULTS[taskSlot]
  const fallbackProvider = resolved.fallbackProvider ?? 'anthropic'
  const matchesPrimary = !result.usedFallback &&
    result.model === resolved.model && result.provider === resolved.provider
  const matchesConfiguredFallback = result.usedFallback &&
    !!resolved.fallbackModel &&
    result.model === resolved.fallbackModel &&
    result.provider === fallbackProvider
  const defaultProvider = defaults.provider ?? 'anthropic'
  const matchesTaskDefault = result.usedFallback &&
    result.model === defaults.model && result.provider === defaultProvider
  const kind = result.attemptKind ?? (() => {
    if (matchesPrimary) return 'primary' as const
    if (matchesConfiguredFallback !== matchesTaskDefault) {
      return matchesConfiguredFallback ? 'configured-fallback' as const : 'task-default' as const
    }
    throw new Error('completion result does not identify one unambiguous pinned route attempt')
  })()
  const kindMatches = kind === 'primary'
    ? matchesPrimary
    : kind === 'configured-fallback'
      ? matchesConfiguredFallback
      : matchesTaskDefault
  if (!kindMatches) throw new Error('completion result does not match its pinned route attempt')
  const usesTaskDefault = kind === 'task-default'

  return {
    kind,
    model: result.model,
    provider: result.provider,
    maxTokens: overrides.maxTokens ?? (usesTaskDefault ? defaults.maxTokens : resolved.maxTokens),
    temperature: overrides.temperature ?? resolved.temperature ?? null,
    reasoningEffort: overrides.reasoningEffort ?? (
      usesTaskDefault ? defaults.reasoningEffort : resolved.reasoningEffort
    ) ?? null,
  }
}

/**
 * Immutable execution facts. `configDigest` covers the full resolved route,
 * selected attempt, and effective request controls; `fingerprint` additionally
 * binds the prompt/schema contract version. Neither field means "calibrated".
 */
export function modelExecutionProvenanceOf(input: {
  snapshot: ModelConfigSnapshot
  result: Pick<CompletionResult, 'model' | 'provider' | 'usedFallback' | 'attemptKind'>
  contractVersion: string
  overrides?: ExecutionOverrides
}): ModelExecutionProvenance {
  const overrides = input.overrides ?? {}
  const attempt = executionAttemptOf(input.snapshot, input.result, overrides)
  const configDigest = digest({
    taskSlot: input.snapshot.taskSlot,
    resolved: safeResolvedModel(input.snapshot.resolved),
    attempt,
  })
  const facts = {
    schemaVersion: AI_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    taskSlot: input.snapshot.taskSlot,
    contractVersion: input.contractVersion,
    model: input.result.model,
    provider: input.result.provider,
    usedFallback: input.result.usedFallback,
    attemptKind: attempt.kind,
    configDigest,
  } as const
  return { ...facts, fingerprint: digest(facts) }
}

export function primaryModelExecutionProvenanceOf(input: {
  snapshot: ModelConfigSnapshot
  contractVersion: string
  overrides?: ExecutionOverrides
}): ModelExecutionProvenance {
  return modelExecutionProvenanceOf({
    snapshot: input.snapshot,
    result: {
      model: input.snapshot.resolved.model,
      provider: input.snapshot.resolved.provider,
      usedFallback: false,
      attemptKind: 'primary',
    },
    contractVersion: input.contractVersion,
    overrides: input.overrides,
  })
}

export function isModelExecutionProvenance(value: unknown): value is ModelExecutionProvenance {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ModelExecutionProvenance>
  if (
    candidate.schemaVersion !== AI_EXECUTION_PROVENANCE_SCHEMA_VERSION ||
    typeof candidate.taskSlot !== 'string' ||
    !TASK_SLOTS.some((taskSlot) => taskSlot === candidate.taskSlot) ||
    typeof candidate.contractVersion !== 'string' || !candidate.contractVersion ||
    typeof candidate.model !== 'string' || !candidate.model ||
    typeof candidate.provider !== 'string' || !candidate.provider ||
    typeof candidate.usedFallback !== 'boolean' ||
    !['primary', 'configured-fallback', 'task-default'].includes(String(candidate.attemptKind)) ||
    (candidate.attemptKind === 'primary') === candidate.usedFallback ||
    typeof candidate.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.configDigest) ||
    typeof candidate.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.fingerprint)
  ) return false

  const facts = {
    schemaVersion: candidate.schemaVersion,
    taskSlot: candidate.taskSlot,
    contractVersion: candidate.contractVersion,
    model: candidate.model,
    provider: candidate.provider,
    usedFallback: candidate.usedFallback,
    attemptKind: candidate.attemptKind,
    configDigest: candidate.configDigest,
  }
  return digest(facts) === candidate.fingerprint
}

function scoringNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * Binds exactly the evaluation fields consumed by Jobs attribution. Long text
 * is clipped to the worker's prompt bounds before hashing, so the receipt does
 * not claim authority over content the worker never sends to the classifier.
 */
export function answerScoringBindingHash(evaluation: Record<string, unknown>): string {
  return digest({
    questionIndex: Math.trunc(scoringNumber(evaluation.questionIndex)),
    question: String(evaluation.question ?? '').slice(0, 500),
    answer: String(evaluation.answer ?? '').slice(0, 2000),
    relevance: scoringNumber(evaluation.relevance),
    structure: scoringNumber(evaluation.structure),
    specificity: scoringNumber(evaluation.specificity),
    ownership: scoringNumber(evaluation.ownership),
    status: evaluation.status ?? null,
  })
}

export function isAnswerScoringReceipt(value: unknown): value is AnswerScoringReceipt {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AnswerScoringReceipt>
  const recordedAt = candidate.recordedAt instanceof Date
    ? candidate.recordedAt
    : new Date(String(candidate.recordedAt ?? ''))
  return candidate.schemaVersion === ANSWER_SCORING_RECEIPT_SCHEMA_VERSION &&
    typeof candidate.bindingHash === 'string' && /^[a-f0-9]{64}$/.test(candidate.bindingHash) &&
    isModelExecutionProvenance(candidate.execution) &&
    candidate.recordedAt != null && !Number.isNaN(recordedAt.getTime())
}

/** Rollout fallback for a pre-deploy coding/design client that has a session
 * id but does not yet send the Jobs optimization hint. This read is authority;
 * the hint itself never is. */
export async function isCanonicalJobsPracticeSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  await connectDB()
  return !!(await InterviewSession.exists({
    _id: sessionId,
    userId,
    'attribution.source': 'jobs',
    'attribution.handoffVersion': 1,
  }))
}

/**
 * Persists a receipt only inside the authenticated user's verified Jobs
 * session. The browser never writes this field, so later evidence can reject
 * forged client evaluation metadata without storing another copy of the
 * answer, question, or raw model output.
 */
export async function recordJobsAnswerScoringReceipt(input: {
  sessionId: string
  userId: string
  evaluation: Record<string, unknown>
  before: ModelConfigSnapshot
  result: Pick<CompletionResult, 'model' | 'provider' | 'usedFallback' | 'attemptKind'>
  contractVersion: string
  overrides?: ExecutionOverrides
  now?: Date
}): Promise<boolean> {
  if (!input.before.authoritative) return false
  let execution: ModelExecutionProvenance
  try {
    execution = modelExecutionProvenanceOf({
      snapshot: input.before,
      result: input.result,
      contractVersion: input.contractVersion,
      overrides: input.overrides,
    })
  } catch {
    return false
  }
  const receipt: AnswerScoringReceipt = {
    schemaVersion: ANSWER_SCORING_RECEIPT_SCHEMA_VERSION,
    bindingHash: answerScoringBindingHash(input.evaluation),
    execution,
    recordedAt: input.now ?? new Date(),
  }

  await connectDB()
  const write = await InterviewSession.updateOne(
    {
      _id: input.sessionId,
      userId: input.userId,
      'attribution.source': 'jobs',
      'attribution.handoffVersion': 1,
    },
    {
      $push: {
        answerScoringReceipts: {
          $each: [receipt],
          $slice: -MAX_JOBS_SCORING_RECEIPTS,
        },
      },
    },
  )
  return (write.matchedCount ?? 0) === 1
}
