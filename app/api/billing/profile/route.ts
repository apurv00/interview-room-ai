import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { ZodError } from 'zod'
import {
  PersonalDataWriteBlockedError,
} from '@shared/services/accountDeletion'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  CustomerBillingProfileConflictError,
  PR6_BILLING_PROFILE_WRITES_READY,
  readCustomerBillingProfile,
  upsertCustomerBillingProfile,
} from '@customer-billing'
import {
  CustomerBillingProfileUpsertSchema,
} from '@payments/validators/customerBillingProfile'
import {
  CustomerBillingProfileResponseSchema,
} from '@payments/validators/customerBillingResponses'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_PROFILE_BODY_BYTES = 4_096
const profileLogger = logger.child({
  module: 'customer-billing-profile',
})

class ProfileBodyError extends Error {
  constructor(readonly status: 400 | 413 | 415) {
    super('Invalid billing profile request')
    this.name = 'ProfileBodyError'
  }
}

function json(
  body: object,
  status: number,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      ...headers,
    },
  })
}

async function rateLimit(
  userId: string,
  scope: 'read' | 'profile',
): Promise<NextResponse | null> {
  try {
    const decision = await checkBillingRouteRateLimit({ userId, scope })
    return decision.allowed
      ? null
      : json(
          { error: 'Too many billing requests' },
          429,
          { 'Retry-After': String(decision.retryAfterSeconds) },
        )
  } catch {
    profileLogger.error(
      { scope },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== 'application/json') throw new ProfileBodyError(415)

  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_PROFILE_BODY_BYTES
  ) {
    throw new ProfileBodyError(413)
  }
  if (!request.body) throw new ProfileBodyError(400)

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_PROFILE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ProfileBodyError(413)
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  } catch (error) {
    if (error instanceof ProfileBodyError) throw error
    throw new ProfileBodyError(400)
  } finally {
    reader.releaseLock()
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401)
  const limited = await rateLimit(session.user.id, 'read')
  if (limited) return limited

  try {
    const profile = await readCustomerBillingProfile(session.user.id)
    return json(
      CustomerBillingProfileResponseSchema.parse(
        profile ?? { configured: false, version: 0 },
      ),
      200,
    )
  } catch (error) {
    profileLogger.error(
      {
        operation: 'read',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Customer billing profile read failed',
    )
    return json(
      { error: 'Billing profile is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401)
  const limited = await rateLimit(session.user.id, 'profile')
  if (limited) return limited
  if (!PR6_BILLING_PROFILE_WRITES_READY) {
    return json(
      {
        error: 'Billing profile updates are not available yet',
        code: 'profile_writes_not_ready',
      },
      503,
    )
  }

  try {
    const input = CustomerBillingProfileUpsertSchema.parse(
      await readJsonBody(request),
    )
    return json(
      CustomerBillingProfileResponseSchema.parse(
        await upsertCustomerBillingProfile(session.user.id, input),
      ),
      200,
    )
  } catch (error) {
    if (error instanceof ProfileBodyError) {
      return json(
        { error: 'Invalid billing profile request' },
        error.status,
      )
    }
    if (error instanceof ZodError) {
      return json(
        {
          error: 'Invalid billing profile request',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
      )
    }
    if (error instanceof CustomerBillingProfileConflictError) {
      return json(
        { error: 'Billing profile changed; refresh and try again' },
        409,
      )
    }
    if (error instanceof PersonalDataWriteBlockedError) {
      return json(
        {
          error:
            'Billing profile cannot change while account deletion is pending',
        },
        409,
      )
    }
    profileLogger.error(
      {
        operation: 'write',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Customer billing profile update failed',
    )
    return json(
      { error: 'Billing profile is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}
