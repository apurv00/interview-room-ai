/**
 * Email-OTP service for B2B candidate invite flow.
 *
 * Context: B2B recruiters invite candidates by email. The candidate arrives
 * at /invite/[sessionId]?token=xxx, enters their email, and receives a
 * 6-digit code. This module generates, stores (Redis), and verifies those
 * codes. It does NOT issue auth sessions — that's done by the
 * `invite-otp` NextAuth Credentials provider, which calls `verifyOtp`.
 *
 * Storage model (Redis):
 *   otp:invite:{sessionId}          → { codeHash, email, issuedAt }   TTL 10m
 *   otp:invite:attempts:{sessionId} → integer counter (attempts across all OTPs
 *                                      for this session)              TTL 30m
 *
 * The attempts counter is deliberately NOT reset when a new OTP is issued —
 * otherwise a brute-forcer could just request a fresh OTP every 5 failures.
 * Lockout is per-session, 30 min, across OTP rotations.
 *
 * Rate limiting (request-otp endpoint caller's responsibility):
 *   - 3 request-otp / email / 15m
 *   - 10 request-otp / IP / 15m
 */

import { createHash, randomInt } from 'crypto'
import { redis } from '@shared/redis'
import { authLogger } from '@shared/logger'

const OTP_TTL_SECONDS = 10 * 60
const ATTEMPT_WINDOW_SECONDS = 30 * 60
const MAX_ATTEMPTS = 5
const CODE_LENGTH = 6

const OTP_KEY_PREFIX = 'otp:invite:'
const ATTEMPTS_KEY_PREFIX = 'otp:invite:attempts:'

function otpKey(sessionId: string): string {
  return `${OTP_KEY_PREFIX}${sessionId}`
}

function attemptsKey(sessionId: string): string {
  return `${ATTEMPTS_KEY_PREFIX}${sessionId}`
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** Constant-time string comparison (prevents timing-oracle attacks on OTP). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface IssuedOtp {
  /** Plaintext 6-digit code. Caller must email it and then discard it. */
  code: string
}

/**
 * Generate a fresh 6-digit OTP for a candidate invite and store its hash
 * in Redis. Overwrites any prior OTP for the same session. Does NOT reset
 * the attempts counter.
 *
 * Returns `null` when Redis is unavailable — the caller should return a
 * 503 so we never silently skip the security boundary.
 */
export async function issueOtp(
  sessionId: string,
  email: string,
): Promise<IssuedOtp | null> {
  const code = String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0')
  const record = {
    codeHash: hashCode(code),
    email: email.toLowerCase(),
    issuedAt: Date.now(),
  }
  try {
    await redis.set(otpKey(sessionId), JSON.stringify(record), 'EX', OTP_TTL_SECONDS)
    return { code }
  } catch (err) {
    authLogger.error({ err, sessionId }, 'issueOtp: Redis error')
    return null
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_otp' | 'expired' | 'mismatch' | 'locked' | 'redis_error' }

/**
 * Verify a candidate-supplied OTP against the stored hash. On success,
 * consumes the OTP (single-use). On failure, increments the attempts
 * counter and — once MAX_ATTEMPTS is hit — returns `locked` until the
 * attempts key TTL expires.
 *
 * Email must match the email the OTP was issued for (case-insensitive).
 */
export async function verifyOtp(
  sessionId: string,
  email: string,
  code: string,
): Promise<VerifyResult> {
  try {
    // Check lockout BEFORE consuming attempts on this request.
    const attempts = await redis.get(attemptsKey(sessionId))
    if (attempts && Number(attempts) >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'locked' }
    }

    const raw = await redis.get(otpKey(sessionId))
    if (!raw) {
      // No OTP stored: either never issued, or already consumed, or expired.
      await recordFailedAttempt(sessionId)
      return { ok: false, reason: 'no_otp' }
    }

    const record = JSON.parse(raw) as { codeHash: string; email: string; issuedAt: number }

    if (record.email !== email.toLowerCase()) {
      await recordFailedAttempt(sessionId)
      return { ok: false, reason: 'mismatch' }
    }

    if (!safeEqual(hashCode(code), record.codeHash)) {
      await recordFailedAttempt(sessionId)
      return { ok: false, reason: 'mismatch' }
    }

    // Success — single-use: delete the OTP so it can't be replayed.
    await redis.del(otpKey(sessionId))
    await redis.del(attemptsKey(sessionId))
    return { ok: true }
  } catch (err) {
    authLogger.error({ err, sessionId }, 'verifyOtp: Redis error')
    return { ok: false, reason: 'redis_error' }
  }
}

async function recordFailedAttempt(sessionId: string): Promise<void> {
  try {
    const key = attemptsKey(sessionId)
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, ATTEMPT_WINDOW_SECONDS)
  } catch (err) {
    authLogger.warn({ err, sessionId }, 'recordFailedAttempt: Redis error')
  }
}

// Exposed for tests only — do not import elsewhere.
export const __internals = {
  OTP_TTL_SECONDS,
  ATTEMPT_WINDOW_SECONDS,
  MAX_ATTEMPTS,
  CODE_LENGTH,
  hashCode,
  otpKey,
  attemptsKey,
}
