import { NextRequest, NextResponse } from 'next/server'
import { ZodSchema, ZodError } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { redis } from '@shared/redis'
import { aiLogger } from '@shared/logger'
import { AppError } from '@shared/errors'
import { getPlanLimits } from '@shared/services/stripe'
import type { AuthUser } from './withAuth'

export type { AuthUser }

export interface ApiContext<T = unknown> {
  user: AuthUser
  body: T
  params: Record<string, string>
}

export type SecureHandler<T> = (
  req: NextRequest,
  ctx: ApiContext<T>
) => Promise<NextResponse>

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
}

export interface ComposeOptions<T> {
  schema?: ZodSchema<T>
  rateLimit: RateLimitConfig
  handler: SecureHandler<T>
  authOptional?: boolean
  requiredRole?: string
}

const ANONYMOUS_USER: AuthUser = {
  id: 'anonymous',
  role: 'candidate',
  plan: 'free',
  email: '',
}

export function composeApiRoute<T>(options: ComposeOptions<T>) {
  return async (
    req: NextRequest,
    context?: { params?: Record<string, string> }
  ): Promise<NextResponse> => {
    try {
      // 1. Auth
      const session = await getServerSession(authOptions)
      let user: AuthUser

      if (session?.user?.id) {
        user = {
          id: session.user.id,
          role: session.user.role,
          organizationId: session.user.organizationId,
          plan: session.user.plan,
          email: session.user.email,
        }
      } else if (options.authOptional) {
        user = ANONYMOUS_USER
      } else {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      // 2. Rate limit — scale maxRequests by plan tier
      const rateLimitKey =
        user.id !== 'anonymous'
          ? user.id
          : req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous'

      const planLimits = getPlanLimits(user.plan || 'free')
      const planScale = planLimits.rateLimitPerMin / 15 // Normalize: free=1x, pro=2x, enterprise=4x
      const effectiveMax = Math.ceil(options.rateLimit.maxRequests * planScale)

      try {
        const key = `${options.rateLimit.keyPrefix}:${rateLimitKey}`
        const current = await redis.incr(key)
        if (current === 1) {
          await redis.pexpire(key, options.rateLimit.windowMs)
        }
        if (current > effectiveMax) {
          aiLogger.warn({ userId: rateLimitKey, key, current }, 'Rate limit exceeded')
          return NextResponse.json(
            { error: 'Rate limit exceeded. Try again later.' },
            {
              status: 429,
              headers: {
                'Retry-After': String(Math.ceil(options.rateLimit.windowMs / 1000)),
              },
            }
          )
        }
      } catch (err) {
        aiLogger.error({ err }, 'Rate limit check failed, allowing request')
      }

      // 2b. Role check
      if (options.requiredRole && user.role !== options.requiredRole && user.role !== 'platform_admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      // 3. Validation
      let body: T
      if (options.schema) {
        const raw = await req.json()
        body = options.schema.parse(raw)
      } else {
        body = {} as T
      }

      // 4. Call handler
      return await options.handler(req, {
        user,
        body,
        params: context?.params ?? {},
      })
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }))
        aiLogger.warn({ details, path: req.nextUrl.pathname }, 'Zod validation failed')
        return NextResponse.json(
          {
            error: 'Validation failed',
            details,
          },
          { status: 400 }
        )
      }
      if (err instanceof AppError) {
        aiLogger.warn({ err, path: req.nextUrl.pathname }, err.message)
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.statusCode }
        )
      }
      aiLogger.error({ err, path: req.nextUrl.pathname }, 'Unhandled error in API route')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
