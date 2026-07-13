import { completion, resolveModel, type CompletionResult } from '@shared/services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '@shared/services/taskSlots'
import { logger } from '@shared/logger'
import { JobVerdictSchema, epochOf, type JobVerdict } from '../config/verdictSchema'
import { buildVerdictPrompt, verdictInputHash, stripRecruiterPii, sliceBody, type VerdictPromptInput, type VerdictHashInput } from '../config/verdictPrompt'
import type { BudgetDecision } from './llmBudget'

/**
 * Posting evaluator (INGESTION §4.5 layer 2) — the ONLY place jobs code
 * touches the model router, and it is strictly additive over completion():
 * this wrapper owns the timeout, the budget gate, the cache, and epoch
 * verification; the router is never modified for it (impact: completion()
 * is CRITICAL, 405 dependents).
 *
 * Retry amplification is capped by construction: one evaluator invocation
 * per posting per sweep = at most TWO model attempts (primary + one JSON
 * repair), each under a 12s Promise.race. Any failure ⇒ `pending`, never a
 * fabricated verdict. usedFallback/model-mismatch results are REJECTED —
 * epochs stay homogeneous (no fallbackModel on the slot; degradation =
 * pending, ruling #8).
 */

const CALL_TIMEOUT_MS = 12_000
const CACHE_PREFIX = 'jobs:verdict:v1:'
const CACHE_TTL_SECONDS = 30 * 24 * 3600

export const VERDICT_SLOT = 'jobs.evaluate-posting' as const

export function expectedVerdictModel(): string {
  return TASK_SLOT_DEFAULTS[VERDICT_SLOT].model
}

/**
 * The epoch model must be the model completion() will actually serve — an
 * active CMS ModelConfig row overrides code defaults (established router
 * behavior), and pinning the epoch to defaults would turn every verdict
 * into a paid-then-rejected model-mismatch after a CMS cutover
 * (adversarial review of Wave 2.3). Falls back to the code default when
 * the router config is unreadable.
 */
export async function resolveExpectedVerdictModel(): Promise<string> {
  try {
    return (await resolveModel(VERDICT_SLOT)).model
  } catch {
    return expectedVerdictModel()
  }
}

export type EvaluationOutcome =
  | {
      ok: true
      verdict: JobVerdict
      model: string
      epoch: string
      inputHash: string
      inputTokens: number
      outputTokens: number
      costUsd: number
      cached: boolean
    }
  | {
      ok: false
      kind: 'budget' | 'timeout' | 'parse' | 'schema' | 'model-mismatch' | 'error'
      message: string
      inputHash: string
      costUsd: number
    }

export interface EvaluatorDeps {
  completionFn?: typeof completion
  cache?: {
    get(key: string): Promise<string | null>
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  }
  checkBudget: (companyKey: string, sourceId: string) => Promise<BudgetDecision>
  recordSpend: (companyKey: string, sourceId: string, costUsd: number) => Promise<void>
  /** CMS-resolved epoch model (resolveExpectedVerdictModel) — callers resolve once per run. */
  expectedModel?: string
  /** USD per 1M tokens — data-tunable via JobsVerdictConfig, defaults there. */
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number }
}

export interface EvaluatePostingInput {
  companyKey: string
  titleKey: string
  locationKey: string
  sourceId: string
  prompt: Omit<VerdictPromptInput, 'body'> & { body: string }
  salaryPresent: boolean
}

function costOf(result: CompletionResult, pricing: EvaluatorDeps['pricing']): number {
  return (result.inputTokens * pricing.inputUsdPerMTok + result.outputTokens * pricing.outputUsdPerMTok) / 1_000_000
}

function withTimeout(p: Promise<CompletionResult>): Promise<CompletionResult> {
  // Not Promise.race: handlers stay attached to the losing promise (a
  // provider that hangs past 12s then rejects must not fire an
  // unhandledRejection and crash the serve process), and the timer is
  // cleared on settle (adversarial review of Wave 2.3).
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('verdict-timeout')), CALL_TIMEOUT_MS)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

export async function evaluatePosting(input: EvaluatePostingInput, deps: EvaluatorDeps): Promise<EvaluationOutcome> {
  const complete = deps.completionFn ?? completion
  const epochModel = deps.expectedModel ?? expectedVerdictModel()
  // Slice BEFORE the PII strip: the strip's regexes must only ever see the
  // ≤4.5k chars the model sees — running them on an unbounded body is a
  // ReDoS surface (adversarial review of Wave 2.3). This also means the
  // hash binds to exactly the model-visible slice: a change beyond the
  // head/tail window deliberately does NOT re-verdict (the model could
  // never have seen it).
  const body = stripRecruiterPii(sliceBody(input.prompt.body))
  const hashInput: VerdictHashInput = {
    companyKey: input.companyKey,
    titleKey: input.titleKey,
    locationKey: input.locationKey,
    normalizedBody: body,
    applyHosts: input.prompt.applyHosts,
    salaryPresent: input.salaryPresent,
    epochModel,
  }
  const inputHash = verdictInputHash(hashInput)

  // Cache before budget: a hit costs nothing, so it must not burn quota.
  if (deps.cache) {
    try {
      const hit = await deps.cache.get(`${CACHE_PREFIX}${inputHash}`)
      if (hit) {
        const parsed = JobVerdictSchema.safeParse(JSON.parse(hit))
        if (parsed.success) {
          return { ok: true, verdict: parsed.data, model: epochModel, epoch: epochOf(epochModel), inputHash, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'verdict cache read failed — falling through to LLM')
    }
  }

  const budget = await deps.checkBudget(input.companyKey, input.sourceId)
  if (!budget.allowed) {
    return { ok: false, kind: 'budget', message: budget.reason ?? 'denied', inputHash, costUsd: 0 }
  }

  const { system, user } = buildVerdictPrompt({ ...input.prompt, body })
  let costUsd = 0
  let raw: CompletionResult
  try {
    raw = await withTimeout(complete({ taskSlot: VERDICT_SLOT, system, messages: [{ role: 'user', content: user }] }))
    costUsd += costOf(raw, deps.pricing)
  } catch (err) {
    const timeout = err instanceof Error && err.message === 'verdict-timeout'
    return { ok: false, kind: timeout ? 'timeout' : 'error', message: String((err as Error)?.message ?? err).slice(0, 200), inputHash, costUsd }
  }

  // Epoch homogeneity: a fallback-served result belongs to a different epoch.
  if (raw.usedFallback || raw.model !== epochModel) {
    await deps.recordSpend(input.companyKey, input.sourceId, costUsd)
    return { ok: false, kind: 'model-mismatch', message: `served by ${raw.model}${raw.usedFallback ? ' (fallback)' : ''}`, inputHash, costUsd }
  }

  let parsed: unknown | undefined
  try {
    parsed = JSON.parse(extractJson(raw.text))
  } catch {
    // One JSON-repair completion max (§4.5) — a second 12s-capped attempt.
    try {
      const repair = await withTimeout(complete({
        taskSlot: VERDICT_SLOT,
        system: 'Fix the following into valid JSON matching the original schema. Return ONLY the corrected JSON — no commentary.',
        messages: [{ role: 'user', content: raw.text.slice(0, 4000) }],
      }))
      costUsd += costOf(repair, deps.pricing)
      if (repair.usedFallback || repair.model !== epochModel) {
        await deps.recordSpend(input.companyKey, input.sourceId, costUsd)
        return { ok: false, kind: 'model-mismatch', message: `repair served by ${repair.model}`, inputHash, costUsd }
      }
      parsed = JSON.parse(extractJson(repair.text))
    } catch (err) {
      await deps.recordSpend(input.companyKey, input.sourceId, costUsd)
      const timeout = err instanceof Error && err.message === 'verdict-timeout'
      return { ok: false, kind: timeout ? 'timeout' : 'parse', message: 'unparseable after one repair', inputHash, costUsd }
    }
  }

  await deps.recordSpend(input.companyKey, input.sourceId, costUsd)
  const validated = JobVerdictSchema.safeParse(parsed)
  if (!validated.success) {
    return { ok: false, kind: 'schema', message: validated.error.issues.map((i) => i.path.join('.')).join(',').slice(0, 200), inputHash, costUsd }
  }

  if (deps.cache) {
    try {
      await deps.cache.set(`${CACHE_PREFIX}${inputHash}`, JSON.stringify(validated.data), 'EX', CACHE_TTL_SECONDS)
    } catch (err) {
      logger.warn({ err }, 'verdict cache write failed')
    }
  }

  return {
    ok: true,
    verdict: validated.data,
    model: raw.model,
    epoch: epochOf(raw.model),
    inputHash,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUsd,
    cached: false,
  }
}
