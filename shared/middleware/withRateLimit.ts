import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
}

export function withRateLimit(config: RateLimitConfig) {
  return function <T extends (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>>(
    handler: T
  ): T {
    const wrapped = async (req: NextRequest, ...args: unknown[]): Promise<NextResponse> => {
      try {
        const userId =
          req.headers.get('x-user-id') ||
          req.headers.get('x-forwarded-for')?.split(',')[0] ||
          'anonymous'
        const key = `${config.keyPrefix}:${userId}`

        const current = await redis.incr(key)
        if (current === 1) {
          await redis.pexpire(key, config.windowMs)
        }

        if (current > config.maxRequests) {
          logger.warn({ userId, key, current }, 'Rate limit exceeded')
          return NextResponse.json(
            { error: 'Rate limit exceeded. Try again later.' },
            {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(config.windowMs / 1000)) },
            }
          )
        }
      } catch (err) {
        // Fail open - if Redis is down, don't block requests
        logger.error({ err }, 'Rate limit check failed, allowing request')
      }

      return handler(req, ...args)
    }

    return wrapped as T
  }
}
