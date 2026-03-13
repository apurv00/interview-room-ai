import { NextResponse } from 'next/server'
import { redis } from '@shared/redis'
import { aiLogger } from '@shared/logger'

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
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
    aiLogger.error({ err }, 'Rate limit check failed, allowing request')
  }
  return null
}
