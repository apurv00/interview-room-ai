import { NextRequest, NextResponse } from 'next/server'
import {
  SubscriptionCheckoutVerificationRequestSchema,
} from '@payments/validators/customerBilling'
import { handleCheckoutVerification } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

function webhookDeferredSuccess(result: { intentId: string }) {
  return json({
    intentId: result.intentId,
    paymentStatus: 'captured',
    status: 'processing',
    pollAfterMs: 2_000,
  }, 202, { 'Retry-After': '2' })
}

export async function POST(request: NextRequest) {
  return handleCheckoutVerification(request, {
    expectedKind: 'subscription',
    schema: SubscriptionCheckoutVerificationRequestSchema,
    // Subscription entitlement authority is the signature-verified
    // subscription.charged webhook. The browser callback is intentionally a
    // state-free hint so it cannot race by creating a provisional fulfillment.
    verify: async ({ intentId }) => ({ intentId }),
    successResponse: webhookDeferredSuccess,
  })
}
