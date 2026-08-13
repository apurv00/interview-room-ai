import { NextResponse } from 'next/server'
import { requireMembership, retryFailedHireScreeningInvitationBatch } from '@hire'
import { composeHireApiRoute } from '../../../../../../_lib/composeHireApiRoute'
import {
  screeningRetryFailedBatchRequestSchema,
  type ScreeningRetryFailedBatchRouteBody,
} from '../../../_lib/schemas'

export const dynamic = 'force-dynamic'

/** Requeue only already-terminal delivery failures; it cannot create a new invite. */
export const POST = composeHireApiRoute<ScreeningRetryFailedBatchRouteBody>({
  schema: screeningRetryFailedBatchRequestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-screening-retry' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await retryFailedHireScreeningInvitationBatch(ctx, {
      jobId: params.jobId,
      batchId: params.batchId,
    })
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
