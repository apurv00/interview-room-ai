import { NextResponse } from 'next/server'
import { redis } from '@shared/redis'
import { aiLogger } from '@shared/logger'

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
  /**
   * Reject (503) instead of allowing when the limiter itself is
   * unavailable. Default false — fail OPEN, so a Redis blip never blocks a
   * legitimate signed-in user, which is right for authed paths where the
   * session is already an abuse bound.
   *
   * Set TRUE on anonymous endpoints that spend money per request (document
   * parse + model call): there the limiter is the ONLY bound, and failing
   * open converts an outage into unbounded spend.
   */
  failClosed?: boolean
}

/**
 * Standalone rate-limit check that can be called from within any API handler.
 * Returns a 429 NextResponse if the limit is exceeded, or null if the request is allowed.
 *
 * Usage:
 *   const blocked = await checkRateLimit(userId || ip, { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:extract' })
 *   if (blocked) return blocked
 */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<NextResponse | null> {
  try {
    const key = `${config.keyPrefix}:${identifier}`
    const current = await redis.incr(key)
    if (current === 1) {
      await redis.pexpire(key, config.windowMs)
    }
    if (current > config.maxRequests) {
      aiLogger.warn({ identifier, key, current }, 'Rate limit exceeded')
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(config.windowMs / 1000)) },
        }
      )
    }
  } catch (err) {
    if (config.failClosed) {
      aiLogger.error(
        { err, keyPrefix: config.keyPrefix },
        'Rate limit check failed on a fail-closed endpoint — rejecting',
      )
      return NextResponse.json(
        { error: 'Temporarily unavailable. Please try again shortly.', code: 'RATE_LIMIT_UNAVAILABLE' },
        { status: 503, headers: { 'Retry-After': '30' } },
      )
    }
    aiLogger.error({ err }, 'Rate limit check failed, allowing request')
  }
  return null
}
