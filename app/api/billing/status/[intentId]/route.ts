import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  BillingIntentStatusNotFoundError,
  readBillingIntentStatus,
} from '@payments/services/billingIntentStatusService'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  BillingIntentIdSchema,
} from '@payments/validators/customerBilling'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const billingStatusLogger = logger.child({
  module: 'billing-intent-status',
})

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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
) {
  const routeParams = await params
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'status',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    billingStatusLogger.error(
      { scope: 'status' },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  const intentId = BillingIntentIdSchema.safeParse(routeParams.intentId)
  if (!intentId.success) {
    return json({ error: 'Billing intent not found' }, 404)
  }

  try {
    const result = await readBillingIntentStatus({
      intentId: intentId.data,
      userId: session.user.id,
    })
    return json({
      intentId: result.intentId,
      kind: result.kind,
      status: result.status,
      terminal: result.terminal,
      ...(result.pollAfterMs !== undefined && {
        pollAfterMs: result.pollAfterMs,
      }),
      updatedAt: result.updatedAt,
    }, 200)
  } catch (error) {
    if (error instanceof BillingIntentStatusNotFoundError) {
      return json({ error: 'Billing intent not found' }, 404)
    }
    billingStatusLogger.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Billing status lookup failed',
    )
    return json(
      { error: 'Billing status is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}
