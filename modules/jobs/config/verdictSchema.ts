import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JOB_DOMAINS } from './domains'

/**
 * LLM posting-verdict contract (INGESTION §4.5 layer 2, ruling #16).
 *
 * Everything the model may say is a CLOSED enum or a bounded scalar — no
 * free-text field exists, so nothing free-text can be persisted (ruling #9:
 * auditability + injection exfiltration). Parse/validation failure means the
 * verdict stays `pending` (≡ rules-only serving), never a fabricated
 * `genuine`.
 *
 * PROMPT_VERSION is part of the full execution epoch and verdictInputHash —
 * bump it whenever buildVerdictPrompt's wording, field set, or this schema
 * changes, or cached/stored verdicts would silently carry semantics the new
 * prompt no longer has.
 */
export const PROMPT_VERSION = 'v2' // v2 2026-07-14: explicit code-class coherence rule in the calibration line

export interface JobsVerdictTokenPricing {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

/**
 * Conservative minimum prices for routes allowed to run the Jobs verdict
 * worker. An unpriced provider/model pair must not make an external call
 * under a dollar budget.
 */
const ROUTE_PRICE_FLOORS: Readonly<Record<string, JobsVerdictTokenPricing>> = {
  'openai:gpt-5.4-mini': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 },
  'openai:gpt-5.6-luna': { inputUsdPerMTok: 1, outputUsdPerMTok: 6 },
  'anthropic:claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  'anthropic:claude-sonnet-4-6': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'anthropic:claude-opus-4-6': { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
}

export function jobsVerdictRoutePriceFloor(
  provider: string,
  model: string,
): JobsVerdictTokenPricing | null {
  return ROUTE_PRICE_FLOORS[`${provider}:${model}`] ?? null
}

export function effectiveJobsVerdictPricing(
  provider: string,
  model: string,
  configuredFloor: JobsVerdictTokenPricing,
): JobsVerdictTokenPricing | null {
  const routeFloor = jobsVerdictRoutePriceFloor(provider, model)
  if (!routeFloor) return null
  return {
    inputUsdPerMTok: Math.max(routeFloor.inputUsdPerMTok, configuredFloor.inputUsdPerMTok),
    outputUsdPerMTok: Math.max(routeFloor.outputUsdPerMTok, configuredFloor.outputUsdPerMTok),
  }
}

/** Frozen reason-code enums — snapshot-tested; additions require a PROMPT_VERSION bump. */
export const FRAUD_REASON_CODES = [
  'fee_fraud',
  'contact_harvest',
  'pii_harvest',
  'mlm_pyramid',
  'training_bait',
  'fake_company',
  'not_a_job',
] as const
export const SUSPICIOUS_REASON_CODES = [
  'mass_repost_shell',
  'title_body_mismatch',
  'vague_jd',
  'salary_unrealistic',
  'walk_in_funnel',
  'consultancy_funnel',
] as const
export const CLEAN_REASON_CODES = ['legit_staffing', 'thin_but_genuine', 'ok'] as const
export const REASON_CODES = [...FRAUD_REASON_CODES, ...SUSPICIOUS_REASON_CODES, ...CLEAN_REASON_CODES] as const

/** Unified taxonomy ids (never a parallel domain vocabulary) + 'other'. */
export const VERDICT_DOMAIN_IDS = [...JOB_DOMAINS.map((d) => d.id), 'other'] as const

export const SENIORITIES = ['fresher', 'junior', 'mid', 'senior', 'lead', 'unspecified'] as const
export const WORK_MODES = ['onsite', 'hybrid', 'remote', 'unspecified'] as const

const scalar01 = z.number().min(0).max(1)

/**
 * Reason codes must JUSTIFY the verdict class (cross-field refinement,
 * Codex on #515): 'genuine' carries only clean codes; 'suspicious' only
 * suspicious codes; 'fraud' needs >=1 fraud code and may cite supporting
 * suspicious signals but never clean ones. A contradictory response
 * (genuine + fee_fraud) is invalid model output — rejected => pending,
 * never stored as scored; the cycle reason counters are the shadow-exit
 * audit trail and must not carry incoherent rows.
 */
const ALLOWED_CODES_BY_VERDICT: Record<string, readonly string[]> = {
  genuine: CLEAN_REASON_CODES,
  suspicious: SUSPICIOUS_REASON_CODES,
  fraud: [...FRAUD_REASON_CODES, ...SUSPICIOUS_REASON_CODES],
}

export const JobVerdictSchema = z
  .object({
    verdict: z.enum(['genuine', 'suspicious', 'fraud']),
    reasonCodes: z.array(z.enum(REASON_CODES as unknown as [string, ...string[]])).min(1).max(4),
    genuineness: scalar01,
    quality: scalar01,
    completeness: scalar01,
    domain: z.enum(VERDICT_DOMAIN_IDS as unknown as [string, ...string[]]),
    domainConfidence: scalar01,
    seniority: z.enum(SENIORITIES),
    fresherFriendly: z.boolean(),
    geo: z.object({
      locations: z.array(z.string().max(80)).max(8),
      workMode: z.enum(WORK_MODES),
    }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed = ALLOWED_CODES_BY_VERDICT[v.verdict]
    if (v.reasonCodes.some((c) => !allowed.includes(c))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCodes'], message: `codes outside the ${v.verdict} class` })
    }
    if (v.verdict === 'fraud' && !v.reasonCodes.some((c) => (FRAUD_REASON_CODES as readonly string[]).includes(c))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCodes'], message: 'fraud requires at least one fraud-class code' })
    }
  })

export type JobVerdict = z.infer<typeof JobVerdictSchema>

/** Verdicts are immutable within an epoch; cutover = founder-triggered re-classification (ruling #8). */
export function epochOf(config: {
  model: string
  provider: string
  maxTokens: number
  temperature?: number
  reasoningEffort?: string
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    model: config.model,
    provider: config.provider,
    maxTokens: config.maxTokens,
    temperature: config.temperature ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
  })).digest('hex')
  return `${config.provider}:${config.model}:${PROMPT_VERSION}:${digest}`
}
