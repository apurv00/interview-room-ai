import { NextRequest, NextResponse } from 'next/server'
import {
  SubscriptionLifecycleError,
  verifyFutureSubscriptionAuthorization,
  type FutureSubscriptionAuthorizationVerificationResult,
} from '@payments/services/subscriptionLifecycleService'
import {
  SubscriptionCheckoutVerificationRequestSchema,
} from '@payments/validators/customerBilling'
import { handleCheckoutVerification } from '../../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

function futureAuthorizationResponse(
  result: FutureSubscriptionAuthorizationVerificationResult,
) {
  const terminal = result.status === 'scheduled'
  const pollAfterMs = result.pollAfterMs ?? 2_000
  return json({
    ...result,
    ...(!terminal ? { pollAfterMs } : {}),
  }, terminal ? 200 : 202, terminal
    ? {}
    : { 'Retry-After': String(Math.ceil(pollAfterMs / 1_000)) })
}

function futureAuthorizationFailure(error: unknown) {
  if (!(error instanceof SubscriptionLifecycleError)) return undefined
  switch (error.code) {
    case 'invalid_request':
    case 'signature_invalid':
      return json({ error: 'Unable to verify mandate authorization' }, 400)
    case 'not_found':
      return json({ error: 'Mandate authorization was not found' }, 404)
    case 'lifecycle_conflict':
    case 'commercial_conflict':
    case 'persistence_conflict':
    case 'review_required':
      return json({ error: 'Mandate authorization requires review' }, 409)
    default:
      return json(
        { error: 'Mandate verification is temporarily unavailable' },
        503,
        { 'Retry-After': '5' },
      )
  }
}

export async function POST(request: NextRequest) {
  return handleCheckoutVerification(request, {
    expectedKind: 'subscription',
    schema: SubscriptionCheckoutVerificationRequestSchema,
    verify: ({
      userId,
      intentId,
      razorpayPaymentId,
      signature,
    }) => verifyFutureSubscriptionAuthorization({
      userId,
      intentId,
      razorpayPaymentId,
      signature,
    }),
    successResponse: futureAuthorizationResponse,
    failureResponse: futureAuthorizationFailure,
  })
}
