import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { parseJobDescription, buildParsedJDContext } from './jdParserService'
import {
  parseAndCacheResume,
  buildParsedResumeContext,
  type ParsedResume,
} from './resumeContextService'
import type { IParsedJobDescription } from '@shared/db/models/SavedJobDescription'

// ─── Cache Configuration ───────────────────────────────────────────────────

const TTL_SECONDS = 1800 // 30 min — matches the default session duration cap.

// Short-TTL negative cache for failed JD parses. Without this, a parse that
// returns empty requirements (truncation / malformed JSON / empty JD) isn't
// cached at all, so every subsequent route call in the session re-fires the
// parse. 120s covers a typical session, self-heals after it ends.
const FAILURE_TTL_SECONDS = 120
const FAILURE_SENTINEL = '__jd_parse_failed__'

const jdKey = (sessionId: string) => `jd:ctx:${sessionId}`
const resumeKey = (sessionId: string) => `resume:ctx:${sessionId}`

// Per-process deduplication: prevents two concurrent requests for the same
// session from both kicking off a fire-and-forget parse.
const inflightJDParses = new Set<string>()
const inflightResumeParses = new Set<string>()

// ─── Primitive Cache Ops ───────────────────────────────────────────────────
// All Redis calls are wrapped in try/catch. Redis failure must never break
// the request path — callers should treat failures as cache misses.

type JDCacheState = 'hit' | 'miss' | 'failed'

async function readJDCacheState(
  sessionId: string,
): Promise<{ state: JDCacheState; ctx: string | null }> {
  try {
    const val = await redis.get(jdKey(sessionId))
    if (!val) return { state: 'miss', ctx: null }
    if (val === FAILURE_SENTINEL) return { state: 'failed', ctx: null }
    return { state: 'hit', ctx: val }
  } catch (err) {
    logger.warn({ err, sessionId }, 'readJDCacheState: redis read failed')
    return { state: 'miss', ctx: null }
  }
}

export async function getCachedJDContext(sessionId: string): Promise<string | null> {
  const res = await readJDCacheState(sessionId)
  return res.state === 'hit' ? res.ctx : null
}

export async function setCachedJDContext(sessionId: string, ctx: string): Promise<void> {
  if (!ctx || ctx === FAILURE_SENTINEL) return
  try {
    await redis.setex(jdKey(sessionId), TTL_SECONDS, ctx)
  } catch (err) {
    logger.warn({ err, sessionId }, 'setCachedJDContext: redis write failed')
  }
}

async function setCachedJDParseFailure(sessionId: string): Promise<void> {
  try {
    // SET NX — only write sentinel when the key is absent. Prevents a
    // concurrent Lambda instance's successful parse from being clobbered
    // in a multi-instance race (inflightJDParses is per-process, so two
    // instances can run parses for the same sessionId; one failure must
    // not overwrite another's valid context).
    await redis.set(jdKey(sessionId), FAILURE_SENTINEL, 'EX', FAILURE_TTL_SECONDS, 'NX')
  } catch (err) {
    logger.warn({ err, sessionId }, 'setCachedJDParseFailure: redis write failed')
  }
}

export async function getCachedResumeContext(sessionId: string): Promise<string | null> {
  try {
    const val = await redis.get(resumeKey(sessionId))
    return val || null
  } catch (err) {
    logger.warn({ err, sessionId }, 'getCachedResumeContext: redis read failed')
    return null
  }
}

export async function setCachedResumeContext(sessionId: string, ctx: string): Promise<void> {
  if (!ctx) return
  try {
    await redis.setex(resumeKey(sessionId), TTL_SECONDS, ctx)
  } catch (err) {
    logger.warn({ err, sessionId }, 'setCachedResumeContext: redis write failed')
  }
}

// ─── Cache-First Loaders (with backfill + fallback) ────────────────────────

/**
 * Returns the compact JD context block for a session.
 *
 * Resolution order:
 *   1. Redis hit (valid ctx) → return
 *   2. Mongo `InterviewSession.parsedJobDescription` → build context, warm Redis, return.
 *      Runs even when Redis holds a failure sentinel, so an externally-written
 *      parsedJobDescription doc can still hydrate the session.
 *   3. Redis held a recent failure sentinel → return null (don't re-trigger parse)
 *   4. Fire-and-forget parse of rawText → on success, store into Mongo + Redis;
 *      on empty result or thrown error, write a short-TTL failure sentinel so
 *      the next call in the same session skips re-parsing and falls straight
 *      through to the raw-JD prompt fallback.
 *      → return null so the CURRENT call falls back to raw .slice()
 */
export async function getOrLoadJDContext(
  sessionId: string,
  rawText: string,
): Promise<string | null> {
  // 1. Redis
  const cached = await readJDCacheState(sessionId)
  if (cached.state === 'hit') return cached.ctx

  // 2. Mongo — always checked, even if Redis held a sentinel.
  try {
    await connectDB()
    const doc = await InterviewSession.findById(sessionId).select('parsedJobDescription').lean()
    const parsed = doc?.parsedJobDescription as IParsedJobDescription | undefined
    if (parsed && Array.isArray(parsed.requirements) && parsed.requirements.length > 0) {
      const ctx = buildParsedJDContext(parsed)
      if (ctx) {
        await setCachedJDContext(sessionId, ctx) // overwrites any sentinel
        return ctx
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'getOrLoadJDContext: Mongo read failed')
  }

  // 3. Recent parse attempt already failed — skip re-parse.
  if (cached.state === 'failed') return null

  // 4. Fire-and-forget parse — populates cache for NEXT call.
  if (rawText && !inflightJDParses.has(sessionId)) {
    inflightJDParses.add(sessionId)
    void (async () => {
      try {
        const parsed = await parseJobDescription(rawText)
        if (parsed && parsed.requirements && parsed.requirements.length > 0) {
          const ctx = buildParsedJDContext(parsed)
          await Promise.allSettled([
            InterviewSession.findByIdAndUpdate(sessionId, {
              parsedJobDescription: parsed,
            }),
            setCachedJDContext(sessionId, ctx),
          ])
        } else {
          await setCachedJDParseFailure(sessionId)
        }
      } catch (err) {
        logger.warn({ err, sessionId }, 'getOrLoadJDContext: background parse failed')
        await setCachedJDParseFailure(sessionId)
      } finally {
        inflightJDParses.delete(sessionId)
      }
    })()
  }

  return null
}

/**
 * Returns the compact resume context block for a session. Same cache-first
 * pattern as `getOrLoadJDContext`.
 */
export async function getOrLoadResumeContext(
  sessionId: string,
  rawText: string,
  domain: string,
): Promise<string | null> {
  // 1. Redis
  const cached = await getCachedResumeContext(sessionId)
  if (cached) return cached

  // 2. Mongo
  try {
    await connectDB()
    const doc = await InterviewSession.findById(sessionId).select('parsedResume').lean()
    const parsed = doc?.parsedResume as ParsedResume | undefined
    if (parsed && Array.isArray(parsed.experience) && parsed.experience.length > 0) {
      const ctx = buildParsedResumeContext(parsed, domain)
      if (ctx) {
        await setCachedResumeContext(sessionId, ctx)
        return ctx
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'getOrLoadResumeContext: Mongo read failed')
  }

  // 3. Fire-and-forget parse
  if (rawText && !inflightResumeParses.has(sessionId)) {
    inflightResumeParses.add(sessionId)
    void (async () => {
      try {
        const parsed = await parseAndCacheResume(sessionId, rawText, domain)
        if (parsed) {
          const ctx = buildParsedResumeContext(parsed, domain)
          await Promise.allSettled([
            InterviewSession.findByIdAndUpdate(sessionId, { parsedResume: parsed }),
            setCachedResumeContext(sessionId, ctx),
          ])
        }
      } catch (err) {
        logger.warn({ err, sessionId }, 'getOrLoadResumeContext: background parse failed')
      } finally {
        inflightResumeParses.delete(sessionId)
      }
    })()
  }

  return null
}
