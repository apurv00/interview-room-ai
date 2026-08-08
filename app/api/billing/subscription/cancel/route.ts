import { NextRequest } from 'next/server'
import {
  initiateCustomerPeriodEndCancellation,
  PR6_CUSTOMER_SUBSCRIPTION_CANCELLATION_READY,
} from '@payments/services/subscriptionLifecycleService'
import {
  SubscriptionPeriodEndCancellationRequestSchema,
} from '@payments/validators/customerBilling'
import { handleSubscriptionLifecycle } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  return handleSubscriptionLifecycle(request, {
    ready: PR6_CUSTOMER_SUBSCRIPTION_CANCELLATION_READY,
    schema: SubscriptionPeriodEndCancellationRequestSchema,
    accepted: true,
    execute: (userId, idempotencyKey) =>
      initiateCustomerPeriodEndCancellation({
        userId,
        idempotencyKey,
      }),
  })
}
