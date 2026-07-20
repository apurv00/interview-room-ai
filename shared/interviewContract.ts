/**
 * Client-safe interview input limits. Upstream producers must not advertise
 * a configuration the interview API will reject.
 */
export const INTERVIEW_JOB_DESCRIPTION_MAX_CHARS = 50_000
export const INTERVIEW_TARGET_COMPANY_MAX_CHARS = 200
export const INTERVIEW_ROLE_SLUG_MAX_CHARS = 100
/** Keeps the CMS-provided role enum bounded before it enters an LLM prompt. */
export const INTERVIEW_INFERENCE_DOMAIN_PROMPT_MAX_ITEMS = 100

/**
 * Bump when the role-inference prompt or normalization semantics change.
 * The active CMS catalog hash is added server-side to form the persisted
 * revision, so both code and operator taxonomy changes invalidate role only.
 */
export const JD_ROLE_INFERENCE_SCHEMA_VERSION = 2

const INTERVIEW_ROLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function normalizeInterviewRoleSlug(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > INTERVIEW_ROLE_SLUG_MAX_CHARS ||
    !INTERVIEW_ROLE_SLUG_PATTERN.test(normalized)
  ) return ''
  return normalized
}
