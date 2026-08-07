import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  cancelCustomerScheduledPlanChange,
  PR6_CUSTOMER_SCHEDULED_CHANGE_CANCELLATION_READY,
} from '@payments/services/subscriptionLifecycleService'
import { handleSubscriptionLifecycle } from '../../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ScheduledPlanChangeCancellationRequestSchema = z.object({
  planChangeRequestId: z.string().regex(/^[a-f\d]{24}$/i),
}).strict()

export async function POST(request: NextRequest) {
  return handleSubscriptionLifecycle(request, {
    ready: PR6_CUSTOMER_SCHEDULED_CHANGE_CANCELLATION_READY,
    schema: ScheduledPlanChangeCancellationRequestSchema,
    accepted: true,
    execute: (userId, _idempotencyKey, body) =>
      cancelCustomerScheduledPlanChange({
        userId,
        planChangeRequestId: body.planChangeRequestId,
      }),
  })
}
