/**
 * Mailbox-control OTPs for Hire candidate and privacy flows.
 *
 * The Redis key/value protocol is intentionally unchanged from the retired
 * B2B module so codes issued before a deployment remain verifiable afterward:
 *
 *   otp:invite:{scope}          -> { codeHash, email, issuedAt }   TTL 10m
 *   otp:invite:attempts:{scope} -> integer counter                 TTL 30m
 *
 * The attempts counter is deliberately not reset when a new OTP is issued;
 * otherwise a brute-forcer could request a fresh code after every five
 * failures. Callers remain responsible for request-rate limiting.
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

function otpKey(scope: string): string {
  return `${OTP_KEY_PREFIX}${scope}`
}

function attemptsKey(scope: string): string {
  return `${ATTEMPTS_KEY_PREFIX}${scope}`
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
 * Generate a fresh 6-digit OTP for a mailbox scope and store its hash in
 * Redis. Overwrites any prior OTP for the same scope. Does not reset the
 * attempts counter.
 *
 * Returns `null` when Redis is unavailable; callers fail closed with 503.
 */
export async function issueOtp(
  scope: string,
  email: string,
): Promise<IssuedOtp | null> {
  const code = String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0')
  const record = {
    codeHash: hashCode(code),
    email: email.toLowerCase(),
    issuedAt: Date.now(),
  }
  try {
    await redis.set(otpKey(scope), JSON.stringify(record), 'EX', OTP_TTL_SECONDS)
    return { code }
  } catch (err) {
    authLogger.error({ err, sessionId: scope }, 'issueOtp: Redis error')
    return null
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_otp' | 'expired' | 'mismatch' | 'locked' | 'redis_error' }

/**
 * Verify a candidate-supplied OTP against the stored hash. On success,
 * consumes the OTP. On failure, increments the scope-wide attempts counter.
 */
export async function verifyOtp(
  scope: string,
  email: string,
  code: string,
): Promise<VerifyResult> {
  try {
    const attempts = await redis.get(attemptsKey(scope))
    if (attempts && Number(attempts) >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'locked' }
    }

    const raw = await redis.get(otpKey(scope))
    if (!raw) {
      await recordFailedAttempt(scope)
      return { ok: false, reason: 'no_otp' }
    }

    const record = JSON.parse(raw) as { codeHash: string; email: string; issuedAt: number }

    if (record.email !== email.toLowerCase()) {
      await recordFailedAttempt(scope)
      return { ok: false, reason: 'mismatch' }
    }

    if (!safeEqual(hashCode(code), record.codeHash)) {
      await recordFailedAttempt(scope)
      return { ok: false, reason: 'mismatch' }
    }

    await redis.del(otpKey(scope))
    await redis.del(attemptsKey(scope))
    return { ok: true }
  } catch (err) {
    authLogger.error({ err, sessionId: scope }, 'verifyOtp: Redis error')
    return { ok: false, reason: 'redis_error' }
  }
}

async function recordFailedAttempt(scope: string): Promise<void> {
  try {
    const key = attemptsKey(scope)
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, ATTEMPT_WINDOW_SECONDS)
  } catch (err) {
    authLogger.warn({ err, sessionId: scope }, 'recordFailedAttempt: Redis error')
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
