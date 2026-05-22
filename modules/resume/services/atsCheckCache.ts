import { createHash } from 'crypto'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'

/**
 * SHA-256 keyed Redis cache for ATS check results.
 *
 * Wave 4 / UAT-024: a single ATS check runs the Sonnet `resume.ats-check`
 * slot at ~35 s wall-clock on production. Most repeat requests in
 * practice come from the same user iterating on the same resume +
 * JD pair (or anonymous IPs hitting the same paste-bin example). A
 * deterministic content-keyed cache lets those follow-ups answer in
 * <100ms.
 *
 * Key shape:  ats-check:v1:<sha256(normalize(resume) | normalize(jd))>
 * TTL:        7 days
 *
 * Normalization is deliberately conservative — we collapse whitespace
 * and lower-case the content, but keep punctuation. Two near-identical
 * pastes that differ only in trailing newlines or capitalization hit
 * the same cache entry; a real edit (added bullet, changed metric)
 * cleanly misses.
 *
 * Bumping the `v1` namespace forces a global invalidation — do it
 * whenever the LLM prompt shape or response schema changes.
 */

const CACHE_KEY_PREFIX = 'ats-check:v1:'
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

function normalize(input: string | null | undefined): string {
  if (!input) return ''
  return String(input).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Build the cache key for a (resumeText, jobDescription) pair. */
export function buildAtsCacheKey(input: { resumeText: string; jobDescription?: string }): string {
  const composite = `${normalize(input.resumeText)}\n|||\n${normalize(input.jobDescription)}`
  const hash = createHash('sha256').update(composite).digest('hex')
  return `${CACHE_KEY_PREFIX}${hash}`
}

/**
 * Read a cached ATS result. Returns null on miss, on Redis errors, or
 * on malformed cached payload (next request rebuilds).
 */
export async function getCachedAtsResult<T = unknown>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch (err) {
    logger.warn({ err, key }, 'ats-check cache read failed — falling through to LLM')
    return null
  }
}

/**
 * Persist an ATS result. Errors are logged and swallowed — a cache
 * write failure must never break the user-facing response.
 */
export async function setCachedAtsResult(key: string, value: unknown): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS)
  } catch (err) {
    logger.warn({ err, key }, 'ats-check cache write failed — request still served')
  }
}
