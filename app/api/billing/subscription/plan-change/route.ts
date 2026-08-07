import { NextRequest } from 'next/server'
import {
  initiateCustomerFuturePlanChange,
  PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
} from '@payments/services/subscriptionLifecycleService'
import {
  SubscriptionPlanChangeRequestSchema,
} from '@payments/validators/customerBilling'
import { handleSubscriptionLifecycle } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CustomerPlanChangeRequestSchema =
  SubscriptionPlanChangeRequestSchema.refine(
    (body) => body.action === 'schedule' &&
      body.manualCouponCode === undefined,
    { message: 'Coupons are not available for future plan changes' },
  )

export async function POST(request: NextRequest) {
  return handleSubscriptionLifecycle(request, {
    ready: PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
    schema: CustomerPlanChangeRequestSchema,
    accepted: true,
    execute: (userId, idempotencyKey, body) => {
      if (body.action !== 'schedule') {
        throw new Error('Validated plan-change action is inconsistent')
      }
      return initiateCustomerFuturePlanChange({
        userId,
        idempotencyKey,
        operation: 'tier_change',
        targetPlanKey: body.targetPlanKey,
      })
    },
  })
}
