/**
 * Feedback generation idempotency lock (Work Item G.6, Phase A).
 *
 * Problem: `modules/interview/hooks/useInterview.ts:889` fires a
 * fire-and-forget POST to /api/generate-feedback when the interview
 * ends; `app/feedback/[sessionId]/page.tsx:453` fires a second POST
 * after an 8s poll-miss on `session.feedback`. Since feedback
 * generation routinely takes 8-20s, both requests run concurrently,
 * race the `InterviewSession.findByIdAndUpdate` write, double the
 * LLM bill, and double-fire every post-feedback side effect
 * (competency, pathway, summary, weakness clusters, XP). Users can
 * see two different `overall_score` values depending on which
 * write wins.
 *
 * Solution: Redis SETNX lock keyed on sessionId. The first request
 * acquires it; any concurrent request gets null back and the caller
 * returns 202 with {status: 'in_progress'} so the client's existing
 * poll loop (feedback/[sessionId]/page.tsx:421-450) picks up the
 * feedback written by the first request.
 *
 * Design contract:
 *   - Lock release uses a Lua CAS so a late release from an expired
 *     holder doesn't delete a newly-acquired lock. Random lockValue
 *     guarantees distinctness across concurrent holders.
 *   - TTL defaults to 120s — generous cap for Sonnet feedback gen
 *     (P99 ~20s) + post-feedback side effects + any retry on
 *     truncation. Lock auto-expires so a crashed handler never
 *     locks the session forever.
 *   - Never throws. If Redis is down the caller gets a best-effort
 *     `{ lockKey, lockValue }` so it continues as today (Redis
 *     unavailability is not worse than pre-G.6 behavior). Logged as
 *     a warn so ops sees the degradation.
 */

import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { randomBytes } from 'crypto'

/** Lock TTL. See design note above. */
const FEEDBACK_LOCK_TTL_MS = 120_000

/** Key prefix keeps feedback locks separate from rate-limit keys. */
const FEEDBACK_LOCK_PREFIX = 'feedback:lock:'

export interface FeedbackLock {
  lockKey: string
  lockValue: string
  /**
   * True if we actually acquired the lock. False means Redis was
   * unavailable and we returned a best-effort handle so the caller
   * proceeds as today (no regression from pre-G.6 behavior).
   */
  acquired: boolean
}

/**
 * Attempt to acquire the feedback lock for `sessionId`. Returns:
 *   - `{ acquired: true, ... }`  — we own the lock; proceed with
 *                                    feedback generation.
 *   - `null`                      — another caller holds the lock;
 *                                    return 202 so the client polls.
 *   - `{ acquired: false, ... }` — Redis errored; proceed as today
 *                                    (fail-open preserves legacy
 *                                    behavior).
 */
export async function acquireFeedbackLock(
  sessionId: string,
  ttlMs: number = FEEDBACK_LOCK_TTL_MS,
): Promise<FeedbackLock | null> {
  const lockKey = `${FEEDBACK_LOCK_PREFIX}${sessionId}`
  const lockValue = randomBytes(16).toString('hex')

  try {
    // NX: set only if not already set. PX: millisecond TTL.
    // Returns 'OK' on success, null when the key already exists.
    const result = await redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX')
    if (result === 'OK') {
      return { lockKey, lockValue, acquired: true }
    }
    // Another caller holds it — signal contention.
    return null
  } catch (err) {
    logger.warn({ err, sessionId }, 'acquireFeedbackLock: Redis error, failing open')
    // Fail open — same behavior as pre-G.6. The caller proceeds
    // without contention detection rather than blocking forever.
    return { lockKey, lockValue, acquired: false }
  }
}

/**
 * Release a lock obtained via `acquireFeedbackLock`. Uses a Lua CAS
 * so a late release from a holder whose TTL expired doesn't delete
 * a newly-acquired lock held by a different request.
 *
 * No-op when the `lock.acquired === false` (we never owned it).
 */
export async function releaseFeedbackLock(lock: FeedbackLock): Promise<void> {
  if (!lock.acquired) return
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `
  try {
    await redis.eval(script, 1, lock.lockKey, lock.lockValue)
  } catch (err) {
    logger.warn({ err, lockKey: lock.lockKey }, 'releaseFeedbackLock: Redis error, lock will auto-expire')
  }
}
