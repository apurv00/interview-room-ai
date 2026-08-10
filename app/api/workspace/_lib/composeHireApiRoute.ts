import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { ZodError, type ZodSchema } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { AppError } from '@shared/errors'
import { aiLogger } from '@shared/logger'
import { redis } from '@shared/redis'
import { getPlanLimits } from '@shared/services/stripe'
import {
  HIRE_MEMBER_COOKIE,
  resolveHireMemberSession,
} from '@hire/services/memberAuthService'
import { getWorkspaceForUser } from '@hire/services/workspaceService'

export interface HireApiUser {
  id: string
  email: string
  role: string
  plan: string
  organizationId?: string
}

export interface HireApiContext<T> {
  user: HireApiUser
  body: T
  params: Record<string, string>
  /** Re-resolves the current principal without crossing identity systems. */
  isPrincipalActive: () => Promise<boolean>
}

interface HireRateLimitConfig {
  windowMs: number
  maxRequests: number
  keyPrefix: string
}

interface ComposeHireOptions<T> {
  schema?: ZodSchema<T>
  rateLimit: HireRateLimitConfig
  handler: (req: NextRequest, ctx: HireApiContext<T>) => Promise<NextResponse>
}

type ResolvedPrincipal = {
  user: HireApiUser
  kind: 'hire_member' | 'b2c'
  rawHireToken?: string
  /**
   * Snapshot the linked workspace at request entry. `null` is meaningful: a
   * valid B2C HR principal has not created its first workspace yet. Keeping
   * this snapshot lets the egress fence distinguish onboarding from a member
   * whose access was removed while private output was being prepared.
   */
  workspaceIdAtEntry?: string | null
}

function isWorkspaceBootstrapRequest(req: NextRequest): boolean {
  return (
    req.nextUrl.pathname === '/api/workspace' &&
    (req.method === 'GET' || req.method === 'POST')
  )
}

async function resolvePrincipal(req: NextRequest): Promise<ResolvedPrincipal | null> {
  const rawHireToken = req.cookies.get(HIRE_MEMBER_COOKIE)?.value
  const hire = await resolveHireMemberSession(rawHireToken)
  if (hire) {
    return {
      kind: 'hire_member',
      rawHireToken,
      user: {
        id: `hire-member:${hire.workspace._id.toString()}:${hire.membership._id.toString()}`,
        email: hire.membership.email,
        role: hire.membership.role,
        plan: 'free',
      },
    }
  }

  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return null
  const user: HireApiUser = {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
    plan: session.user.plan,
    organizationId: session.user.organizationId,
  }
  const workspaceAtEntry = await getWorkspaceForUser({
    userId: user.id,
    email: user.email,
  })
  return {
    kind: 'b2c',
    user,
    workspaceIdAtEntry:
      workspaceAtEntry?.workspace._id.toString() ?? null,
  }
}

async function principalStillActive(
  principal: ResolvedPrincipal,
  req: NextRequest,
): Promise<boolean> {
  if (principal.kind === 'hire_member') {
    return !!(await resolveHireMemberSession(principal.rawHireToken))
  }
  const current = await getWorkspaceForUser({
    userId: principal.user.id,
    email: principal.user.email,
  })
  if (principal.workspaceIdAtEntry) {
    return (
      current?.workspace._id.toString() === principal.workspaceIdAtEntry
    )
  }

  // A signed B2C principal with no Hire membership may only discover or
  // create its first workspace. Every other endpoint remains membership
  // gated, and a linked principal that loses access never reaches this branch
  // because its entry snapshot contains the former workspace id.
  return isWorkspaceBootstrapRequest(req)
}

function accountUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

/**
 * Workspace-only HTTP boundary. It accepts either the existing B2C session
 * for a linked HR member or a Hire-owned password session. Candidate guest
 * credentials are never accepted here, and Hire-member sessions never query
 * or mutate the B2C User collection.
 */
export function composeHireApiRoute<T = unknown>(options: ComposeHireOptions<T>) {
  return async (
    req: NextRequest,
    context?: { params?: Record<string, string> }
  ): Promise<NextResponse> => {
    try {
      if (
        process.env.NODE_ENV === 'production' &&
        process.env.IPG_SURFACE !== 'hire-control'
      ) {
        return NextResponse.json(
          { error: 'Hire control surface is unavailable' },
          { status: 503 },
        )
      }
      const principal = await resolvePrincipal(req)
      if (!principal) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      try {
        const limits = getPlanLimits(principal.user.plan || 'free')
        const scale = limits.rateLimitPerMin / 15
        const max = Math.ceil(options.rateLimit.maxRequests * scale)
        const key = `${options.rateLimit.keyPrefix}:${principal.user.id}`
        const current = await redis.incr(key)
        if (current === 1) await redis.pexpire(key, options.rateLimit.windowMs)
        if (current > max) {
          return NextResponse.json(
            { error: 'Rate limit exceeded. Try again later.' },
            {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(options.rateLimit.windowMs / 1000)) },
            }
          )
        }
      } catch (err) {
        aiLogger.error({ err }, 'Hire workspace rate-limit check failed, allowing request')
      }

      const body = options.schema
        ? options.schema.parse(await req.json())
        : ({} as T)
      let response: NextResponse
      try {
        response = await options.handler(req, {
          user: principal.user,
          body,
          params: context?.params ?? {},
          isPrincipalActive: () => principalStillActive(principal, req),
        })
      } catch (handlerError) {
        try {
          if (!(await principalStillActive(principal, req))) {
            return accountUnavailableResponse()
          }
        } catch (recheckError) {
          // Preserve the handler's original AppError/diagnostic contract if
          // the exception-path membership lookup itself is unavailable.
          aiLogger.error(
            { err: recheckError, path: req.nextUrl.pathname },
            'Hire principal exception-path recheck failed',
          )
        }
        throw handlerError
      }

      // Removal/account-deletion racing a read cannot release private output.
      if (!(await principalStillActive(principal, req))) {
        return accountUnavailableResponse()
      }
      return response
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            details: err.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
          { status: 400 }
        )
      }
      if (err instanceof AppError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.statusCode }
        )
      }
      aiLogger.error({ err, path: req.nextUrl.pathname }, 'Unhandled Hire workspace error')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
