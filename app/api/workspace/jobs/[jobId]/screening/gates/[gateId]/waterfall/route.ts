import { NextResponse } from 'next/server'
import { createHireScreeningInvitationWaterfall, requireMembership } from '@hire'
import { composeHireApiRoute } from '../../../../../../_lib/composeHireApiRoute'
import {
  screeningWaterfallRequestSchema,
  type ScreeningWaterfallRouteBody,
} from '../../../_lib/schemas'

export const dynamic = 'force-dynamic'

/**
 * HR-only command for a new bounded wave from this gate's unreserved ranked
 * remainder. The service is authoritative: this route never accepts an
 * application list and therefore cannot bypass the frozen screening gate.
 */
export const POST = composeHireApiRoute<ScreeningWaterfallRouteBody>({
  schema: screeningWaterfallRequestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-screening-waterfall' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await createHireScreeningInvitationWaterfall(ctx, {
      jobId: params.jobId,
      gateId: params.gateId,
      count: body.count,
      ...(body.sendAfter ? { sendAfter: body.sendAfter } : {}),
    })
    return NextResponse.json(result, {
      status: 201,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
