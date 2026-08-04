import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { ZodType } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  createOneTimeCheckout,
  OneTimeCheckoutError,
  type OneTimeCheckoutInput,
  type OneTimeCheckoutResult,
  type OneTimeCheckoutSku,
} from '@payments/services/oneTimeCheckoutService'
import {
  CustomerBillingIdempotencyKeySchema,
} from '@payments/validators/customerBilling'
import {
  createCheckoutIntentWithCommercialAnalytics,
} from '@/app/api/_lib/paymentCommercialAnalyticsComposition'
import {
  mintCheckoutObservation,
  type CheckoutObservationAuthority,
} from '@/app/api/_lib/commercialFunnelAnalyticsComposition'

const MAX_ORDER_BODY_BYTES = 512
const orderLogger = logger.child({
  module: 'one-time-order-route',
})

class OrderRequestBodyError extends Error {
  constructor(readonly status: 413 | 415) {
    super('Invalid one-time order request body')
    this.name = 'OrderRequestBodyError'
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
    throw new OrderRequestBodyError(415)
  }

  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_ORDER_BODY_BYTES
  ) {
    throw new OrderRequestBodyError(413)
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
      if (byteLength > MAX_ORDER_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new OrderRequestBodyError(413)
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body)
}

function publicCheckoutResult(
  result: OneTimeCheckoutResult,
  analyticsObservation?: CheckoutObservationAuthority,
): OneTimeCheckoutResult & {
  analyticsObservation?: CheckoutObservationAuthority
} {
  return {
    intentId: result.intentId,
    providerMode: result.providerMode,
    intentStatus: result.intentStatus,
    reused: result.reused,
    checkout: {
      keyId: result.checkout.keyId,
      orderId: result.checkout.orderId,
    },
    quote: {
      quoteId: result.quote.quoteId,
      expiresAt: result.quote.expiresAt,
      catalogVersion: result.quote.catalogVersion,
      sku: result.quote.sku,
      currency: result.quote.currency,
      gstInclusive: result.quote.gstInclusive,
      gstRatePercent: result.quote.gstRatePercent,
      listPricePaise: result.quote.listPricePaise,
      discountPaise: result.quote.discountPaise,
      payablePaise: result.quote.payablePaise,
      disclosure: {
        summary: result.quote.disclosure.summary,
        why: result.quote.disclosure.why,
        gst: result.quote.disclosure.gst,
      },
      entitlementSummary: structuredClone(
        result.quote.entitlementSummary,
      ),
    },
    ...(analyticsObservation ? { analyticsObservation } : {}),
  }
}

function checkoutFailure(error: OneTimeCheckoutError) {
  switch (error.code) {
    case 'invalid_request':
      return json({ error: 'Invalid one-time checkout request' }, 400)
    case 'resume_unavailable':
      return json({ error: 'Saved resume not found' }, 404)
    case 'billing_profile_required':
      return json({
        error: 'Add your billing state before checkout',
        code: 'billing_profile_required',
      }, 422)
    case 'idempotency_conflict':
      return json({ error: 'One-time checkout conflict' }, 409)
    case 'review_required':
    case 'persistence_conflict':
      return json({ error: 'One-time checkout requires review' }, 409)
    case 'sale_blocked':
    case 'buyer_unavailable':
    case 'commercial_unavailable':
    case 'provider_unavailable':
      return json(
        { error: 'One-time checkout is temporarily unavailable' },
        503,
        { 'Retry-After': error.code === 'sale_blocked' ? '30' : '5' },
      )
  }
}

export async function handleOneTimeOrder<TBody>(
  request: NextRequest,
  input: {
    sku: OneTimeCheckoutSku
    schema: ZodType<TBody>
    toCheckoutRequest: (
      body: TBody,
    ) => OneTimeCheckoutInput['request']
  },
) {
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
    orderLogger.error(
      { scope: 'checkout', sku: input.sku },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  let body: TBody
  let idempotencyKey: string
  try {
    idempotencyKey = CustomerBillingIdempotencyKeySchema.parse(
      request.headers.get('idempotency-key'),
    )
    const parsed = input.schema.safeParse(await readJsonBody(request))
    if (!parsed.success) {
      return json({ error: 'Invalid one-time checkout request' }, 400)
    }
    body = parsed.data
  } catch (error) {
    if (error instanceof OrderRequestBodyError) {
      return json(
        { error: 'Invalid one-time checkout request' },
        error.status,
      )
    }
    return json({ error: 'Invalid one-time checkout request' }, 400)
  }

  try {
    const checkout = await createOneTimeCheckout({
      userId: session.user.id,
      idempotencyKey,
      request: input.toCheckoutRequest(body),
    }, {
      createIntent: createCheckoutIntentWithCommercialAnalytics,
      })
    const analyticsObservation = await mintCheckoutObservation({
      userId: session.user.id,
      intentId: checkout.intentId,
      providerMode: checkout.providerMode,
      catalogVersion: checkout.quote.catalogVersion,
      productKey: checkout.quote.sku,
      listPricePaise: checkout.quote.listPricePaise,
      discountPaise: checkout.quote.discountPaise,
      payablePaise: checkout.quote.payablePaise,
      renewalPricePaise: null,
      requestOrigin: request.headers.get('origin'),
      fetchSite: request.headers.get('sec-fetch-site'),
    }).catch(() => null)
    return json(
      publicCheckoutResult(
        checkout,
        analyticsObservation ?? undefined,
      ),
      checkout.reused ? 200 : 201,
    )
  } catch (error) {
    const checkoutError = error instanceof OneTimeCheckoutError
      ? error
      : undefined
    orderLogger.error(
      {
        errorCode: checkoutError?.code ?? 'unexpected',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        sku: input.sku,
      },
      'One-time checkout failed',
    )
    return checkoutError
      ? checkoutFailure(checkoutError)
      : json(
          { error: 'One-time checkout is temporarily unavailable' },
          503,
          { 'Retry-After': '5' },
        )
  }
}
