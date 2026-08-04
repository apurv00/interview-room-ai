import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  CustomerBillingUnavailableError,
  readCustomerBillingSummary,
} from '@customer-billing'
import {
  CustomerBillingSummaryResponseSchema,
} from '@payments/validators/customerBillingResponses'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const billingMeLogger = logger.child({ module: 'customer-billing-me' })

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

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'read',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    billingMeLogger.error(
      { scope: 'read' },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  const rawEnvironment =
    request.nextUrl.searchParams.get('environment') ?? null
  if (
    rawEnvironment !== null &&
    rawEnvironment !== 'live' &&
    rawEnvironment !== 'test'
  ) {
    return json({ error: 'Invalid billing account request' }, 400)
  }
  const environment = rawEnvironment ?? undefined

  try {
    return json(
      CustomerBillingSummaryResponseSchema.parse(
        await readCustomerBillingSummary(
          session.user.id,
          environment ? { environment } : {},
        ),
      ),
      200,
    )
  } catch (error) {
    if (
      error instanceof CustomerBillingUnavailableError &&
      error.code === 'customer_unavailable'
    ) {
      return json({ error: 'Billing account not found' }, 404)
    }
    if (
      error instanceof CustomerBillingUnavailableError &&
      error.code === 'test_mode_unavailable'
    ) {
      return json({ error: 'Billing account not found' }, 404)
    }
    billingMeLogger.error(
      {
        errorCode: error instanceof CustomerBillingUnavailableError
          ? error.code
          : 'unexpected',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Customer billing summary failed',
    )
    return json(
      { error: 'Billing information is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}
