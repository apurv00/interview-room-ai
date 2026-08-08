import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  createFutureSubscriptionCheckout,
  SubscriptionCheckoutError,
} from '@payments/services/subscriptionCheckoutService'
import {
  PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
  SubscriptionLifecycleError,
} from '@payments/services/subscriptionLifecycleService'
import { handleSubscriptionLifecycle } from '../../../subscription/routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const FutureSubscriptionCheckoutRequestSchema = z.object({
  planChangeRequestId: z.string().regex(/^[a-f\d]{24}$/i),
}).strict()

function lifecycleCheckoutFailure(
  error: SubscriptionCheckoutError,
): SubscriptionLifecycleError {
  switch (error.code) {
    case 'invalid_request':
      return new SubscriptionLifecycleError('invalid_request', error.message)
    case 'sale_blocked':
      return new SubscriptionLifecycleError('sale_blocked', error.message)
    case 'idempotency_conflict':
    case 'subscription_conflict':
    case 'persistence_conflict':
      return new SubscriptionLifecycleError(
        'lifecycle_conflict',
        error.message,
      )
    case 'review_required':
      return new SubscriptionLifecycleError('review_required', error.message)
    default:
      return new SubscriptionLifecycleError(
        'provider_unavailable',
        error.message,
      )
  }
}

export async function POST(request: NextRequest) {
  return handleSubscriptionLifecycle(request, {
    ready: PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY,
    schema: FutureSubscriptionCheckoutRequestSchema,
    execute: async (userId, idempotencyKey, body) => {
      try {
        return await createFutureSubscriptionCheckout({
          userId,
          idempotencyKey,
          planChangeRequestId: body.planChangeRequestId,
        })
      } catch (error) {
        if (error instanceof SubscriptionCheckoutError) {
          throw lifecycleCheckoutFailure(error)
        }
        throw error
      }
    },
  })
}
