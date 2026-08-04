import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  CustomerBillingQuoteUnavailableError,
  resolveCustomerBillingQuote,
} from '@payments/services/customerBillingQuoteService'
import {
  CustomerBillingQuoteRequestSchema,
} from '@payments/validators/customerBilling'
import {
  recordResolvedQuoteFunnel,
} from '@/app/api/_lib/commercialFunnelAnalyticsComposition'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_QUOTE_BODY_BYTES = 1_024
const quoteLogger = logger.child({ module: 'customer-billing-quote' })

class QuoteRequestBodyError extends Error {
  constructor(
    readonly code: 'unsupported_content_type' | 'request_too_large',
  ) {
    super(code)
    this.name = 'QuoteRequestBodyError'
  }
}

function json(
  body: Record<string, unknown>,
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
    throw new QuoteRequestBodyError('unsupported_content_type')
  }
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_QUOTE_BODY_BYTES
  ) {
    throw new QuoteRequestBodyError('request_too_large')
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
      if (byteLength > MAX_QUOTE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new QuoteRequestBodyError('request_too_large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body)
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'quote',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    quoteLogger.error(
      { scope: 'quote' },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  let parsed
  try {
    const result = CustomerBillingQuoteRequestSchema.safeParse(
      await readJsonBody(request),
    )
    if (!result.success) {
      return json({ error: 'Invalid billing quote request' }, 400)
    }
    parsed = result.data
  } catch (error) {
    if (error instanceof QuoteRequestBodyError) {
      return json(
        { error: 'Invalid billing quote request' },
        error.code === 'unsupported_content_type' ? 415 : 413,
      )
    }
    return json({ error: 'Invalid billing quote request' }, 400)
  }

  try {
    const resolved = await resolveCustomerBillingQuote({
      userId: session.user.id,
      request: parsed,
    })
    try {
      await recordResolvedQuoteFunnel({
        userId: session.user.id,
        surface: parsed.surface,
        ...(parsed.manualCouponCode
          ? { manualCodeLength: parsed.manualCouponCode.length }
          : {}),
        resolved,
      })
    } catch {
      quoteLogger.warn(
        { stage: 'quote_observation' },
        'Billing quote analytics was unavailable',
      )
    }
    return json(resolved.quote, 200)
  } catch (error) {
    quoteLogger.error(
      {
        errorCode:
          error instanceof CustomerBillingQuoteUnavailableError
            ? error.code
            : 'unexpected',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Billing quote generation failed',
    )
    return json(
      { error: 'Billing quote is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}
