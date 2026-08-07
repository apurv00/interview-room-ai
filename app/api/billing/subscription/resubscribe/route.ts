import { NextRequest } from 'next/server'
import {
  initiateCustomerFuturePlanChange,
  PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
} from '@payments/services/subscriptionLifecycleService'
import {
  SubscriptionResubscribeRequestSchema,
} from '@payments/validators/customerBilling'
import { handleSubscriptionLifecycle } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CustomerResubscribeRequestSchema =
  SubscriptionResubscribeRequestSchema.refine(
    (body) => body.manualCouponCode === undefined,
    { message: 'Coupons are not available for future plan changes' },
  )

export async function POST(request: NextRequest) {
  return handleSubscriptionLifecycle(request, {
    ready: PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
    schema: CustomerResubscribeRequestSchema,
    accepted: true,
    execute: (userId, idempotencyKey, body) =>
      initiateCustomerFuturePlanChange({
        userId,
        idempotencyKey,
        operation: 'resubscribe',
      }),
  })
}
