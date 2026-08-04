import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  createSubscriptionCheckout,
  SubscriptionCheckoutError,
} from '@payments/services/subscriptionCheckoutService'
import {
  CustomerBillingIdempotencyKeySchema,
  SubscriptionCheckoutRequestSchema,
} from '@payments/validators/customerBilling'
import {
  createCheckoutIntentWithCommercialAnalytics,
} from '@/app/api/_lib/paymentCommercialAnalyticsComposition'
import {
  mintCheckoutObservation,
} from '@/app/api/_lib/commercialFunnelAnalyticsComposition'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CHECKOUT_BODY_BYTES = 512
const checkoutLogger = logger.child({
  module: 'subscription-checkout-route',
})

class CheckoutRequestBodyError extends Error {
  constructor(
    readonly code: 'unsupported_content_type' | 'request_too_large',
  ) {
    super(code)
    this.name = 'CheckoutRequestBodyError'
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

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    throw new CheckoutRequestBodyError('unsupported_content_type')
  }
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_CHECKOUT_BODY_BYTES
  ) {
    throw new CheckoutRequestBodyError('request_too_large')
  }
  if (!request.body) return JSON.parse('')

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let byteLength = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_CHECKOUT_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new CheckoutRequestBodyError('request_too_large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body)
}

function checkoutFailure(error: SubscriptionCheckoutError) {
  if (error.code === 'invalid_request') {
    return json({ error: 'Invalid subscription checkout request' }, 400)
  }
  if (
    error.code === 'idempotency_conflict' ||
    error.code === 'subscription_conflict'
  ) {
    return json({ error: 'Subscription checkout conflict' }, 409)
  }
  if (error.code === 'billing_profile_required') {
    return json(
      {
        error: 'Add your billing state before checkout',
        code: 'billing_profile_required',
      },
      422,
    )
  }
  if (error.code === 'review_required') {
    return json(
      { error: 'Subscription checkout requires reconciliation' },
      409,
    )
  }
  return json(
    { error: 'Subscription checkout is temporarily unavailable' },
    503,
    { 'Retry-After': error.code === 'sale_blocked' ? '30' : '5' },
  )
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'checkout',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    checkoutLogger.error(
      { scope: 'checkout' },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  let parsedRequest
  let idempotencyKey
  try {
    idempotencyKey = CustomerBillingIdempotencyKeySchema.parse(
      request.headers.get('idempotency-key'),
    )
    const parsed = SubscriptionCheckoutRequestSchema.safeParse(
      await readJsonBody(request),
    )
    if (!parsed.success) {
      return json({ error: 'Invalid subscription checkout request' }, 400)
    }
    parsedRequest = parsed.data
  } catch (error) {
    if (error instanceof CheckoutRequestBodyError) {
      return json(
        { error: 'Invalid subscription checkout request' },
        error.code === 'unsupported_content_type' ? 415 : 413,
      )
    }
    return json({ error: 'Invalid subscription checkout request' }, 400)
  }

  try {
    const checkout = await createSubscriptionCheckout({
      userId: session.user.id,
      idempotencyKey,
      request: parsedRequest,
    }, {
      createIntent: createCheckoutIntentWithCommercialAnalytics,
      })
    const analyticsObservation = await mintCheckoutObservation({
      userId: session.user.id,
      intentId: checkout.intentId,
      providerMode: checkout.providerMode,
      catalogVersion: checkout.quote.catalogVersion,
      productKey: checkout.quote.planKey,
      listPricePaise: checkout.quote.listPricePaise,
      discountPaise: checkout.quote.discountPaise,
      payablePaise: checkout.quote.payablePaise,
      renewalPricePaise: checkout.quote.renewalPricePaise,
      ...(checkout.quote.coupon ? {
        couponCampaignId: checkout.quote.coupon.campaignId,
        couponMode: checkout.quote.coupon.mode,
      } : {}),
      requestOrigin: request.headers.get('origin'),
      fetchSite: request.headers.get('sec-fetch-site'),
    }).catch(() => null)
    return json({
      ...checkout,
      ...(analyticsObservation ? { analyticsObservation } : {}),
    }, checkout.reused ? 200 : 201)
  } catch (error) {
    const checkoutError = error instanceof SubscriptionCheckoutError
      ? error
      : undefined
    checkoutLogger.error(
      {
        errorCode: checkoutError?.code ?? 'unexpected',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Subscription checkout failed',
    )
    return checkoutError
      ? checkoutFailure(checkoutError)
      : json(
          { error: 'Subscription checkout is temporarily unavailable' },
          503,
          { 'Retry-After': '5' },
        )
  }
}
