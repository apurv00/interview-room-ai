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
 * PROMPT_VERSION is part of the epoch (`model:promptVersion`) and of
 * verdictInputHash — bump it whenever buildVerdictPrompt's wording, field
 * set, or this schema changes, or cached/stored verdicts would silently
 * carry semantics the new prompt no longer has.
 */
export const PROMPT_VERSION = 'v1'

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

export type JobVerdict = z.infer<typeof JobVerdictSchema>

/** Verdicts are immutable within an epoch; cutover = founder-triggered re-classification (ruling #8). */
export function epochOf(model: string): string {
  return `${model}:${PROMPT_VERSION}`
}
