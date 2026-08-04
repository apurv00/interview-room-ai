import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import type { ZodType } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { logger } from '@shared/logger'
import {
  CapturedCheckoutVerificationError,
  type CapturedCheckoutExpectedKind,
  type CapturedCheckoutVerificationResult,
} from '@payments/services/capturedCheckoutVerificationService'
import {
  checkBillingRouteRateLimit,
} from '@payments/services/billingRouteRateLimitService'
import {
  verifyCapturedCheckoutWithCommercialAnalytics,
} from '@/app/api/_lib/paymentCommercialAnalyticsComposition'

const billingVerificationLogger = logger.child({
  module: 'billing-checkout-verification',
})

interface VerificationBody {
  intentId: string
  razorpayPaymentId: string
  razorpaySignature: string
}

const MAX_VERIFICATION_BODY_BYTES = 2_048
const CAPTURE_PENDING_RETRY_SECONDS = 7

class VerificationRequestBodyError extends Error {
  readonly code: 'unsupported_content_type' | 'request_too_large'

  constructor(code: VerificationRequestBodyError['code']) {
    super(code)
    this.name = 'VerificationRequestBodyError'
    this.code = code
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

async function parseJsonBody(
  request: NextRequest,
): Promise<unknown> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    throw new VerificationRequestBodyError('unsupported_content_type')
  }

  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_VERIFICATION_BODY_BYTES
  ) {
    throw new VerificationRequestBodyError('request_too_large')
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
      if (byteLength > MAX_VERIFICATION_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new VerificationRequestBodyError('request_too_large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  return JSON.parse(body)
}

function successResponse(
  result: CapturedCheckoutVerificationResult,
) {
  if (
    result.intentStatus === 'fulfilled' ||
    result.fulfillmentStatus === 'done'
  ) {
    return json({
      intentId: result.intentId,
      paymentStatus: 'captured',
      status: 'completed',
    }, 200)
  }
  if (result.fulfillmentStatus === 'review') {
    return json({
      intentId: result.intentId,
      paymentStatus: 'captured',
      status: 'manual_review',
    }, 202)
  }
  return json({
    intentId: result.intentId,
    paymentStatus: 'captured',
    status: 'processing',
    pollAfterMs: 2_000,
  }, 202, { 'Retry-After': '2' })
}

function verificationFailureResponse(
  error: CapturedCheckoutVerificationError,
) {
  switch (error.code) {
    case 'invalid_request':
    case 'signature_invalid':
      return json({ error: 'Unable to verify checkout' }, 400)
    case 'intent_not_found':
      return json({ error: 'Checkout intent not found' }, 404)
    case 'payment_capture_pending':
      return json({
        paymentStatus: 'pending',
        status: 'awaiting_capture',
        pollAfterMs: CAPTURE_PENDING_RETRY_SECONDS * 1_000,
      }, 202, {
        'Retry-After': String(CAPTURE_PENDING_RETRY_SECONDS),
      })
    case 'provider_unavailable':
    case 'persistence_conflict':
      return json(
        { error: 'Checkout verification is temporarily unavailable' },
        503,
        { 'Retry-After': '5' },
      )
    default:
      return json({ error: 'Checkout requires review' }, 409)
  }
}

export interface CheckoutVerificationServiceInput {
  userId: string
  intentId: string
  razorpayPaymentId: string
  signature: string
  expectedKind: CapturedCheckoutExpectedKind
}

export async function handleCheckoutVerification<TResult =
CapturedCheckoutVerificationResult>(
  request: NextRequest,
  input: {
    expectedKind: CapturedCheckoutExpectedKind
    schema: ZodType<VerificationBody>
    verify?: (
      input: CheckoutVerificationServiceInput,
    ) => Promise<TResult>
    successResponse?: (result: TResult) => NextResponse
    failureResponse?: (error: unknown) => NextResponse | undefined
  },
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: session.user.id,
      scope: 'verify',
    })
    if (!rateLimit.allowed) {
      return json(
        { error: 'Too many billing requests' },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      )
    }
  } catch {
    billingVerificationLogger.error(
      { scope: 'verify' },
      'Billing rate limiting is unavailable',
    )
    return json(
      { error: 'Billing request is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }

  let parsed: VerificationBody
  try {
    const candidate = await parseJsonBody(request)
    const result = input.schema.safeParse(candidate)
    if (!result.success) {
      return json({ error: 'Invalid checkout verification request' }, 400)
    }
    parsed = result.data
  } catch (error) {
    if (error instanceof VerificationRequestBodyError) {
      const status = error.code === 'unsupported_content_type' ? 415 : 413
      return json({ error: 'Invalid checkout verification request' }, status)
    }
    return json({ error: 'Invalid checkout verification request' }, 400)
  }

  try {
    const verify = input.verify ??
      (verifyCapturedCheckoutWithCommercialAnalytics as unknown as (
        input: CheckoutVerificationServiceInput,
      ) => Promise<TResult>)
    const result = await verify({
      userId: session.user.id,
      intentId: parsed.intentId,
      razorpayPaymentId: parsed.razorpayPaymentId,
      signature: parsed.razorpaySignature,
      expectedKind: input.expectedKind,
    })
    return input.successResponse
      ? input.successResponse(result)
      : successResponse(
          result as unknown as CapturedCheckoutVerificationResult,
        )
  } catch (error) {
    const customFailure = input.failureResponse?.(error)
    if (customFailure) return customFailure
    if (error instanceof CapturedCheckoutVerificationError) {
      billingVerificationLogger.warn(
        {
          errorCode: error.code,
          expectedKind: input.expectedKind,
        },
        'Checkout verification did not complete',
      )
      return verificationFailureResponse(error)
    }

    billingVerificationLogger.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        expectedKind: input.expectedKind,
      },
      'Checkout verification failed unexpectedly',
    )
    return json(
      { error: 'Checkout verification is temporarily unavailable' },
      503,
      { 'Retry-After': '5' },
    )
  }
}
