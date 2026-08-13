import { NextResponse } from 'next/server'
import {
  previewJobScreeningGate,
  requireMembership,
  type ScreeningGatePreviewRequest,
} from '@hire'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'
import {
  screeningPreviewRequestSchema,
  type ScreeningPreviewRouteBody,
} from '../_lib/schemas'

export const dynamic = 'force-dynamic'

/** Read-only HR review. Confirmation is a separate, explicit mutation. */
export const POST = composeHireApiRoute<ScreeningPreviewRouteBody>({
  schema: screeningPreviewRequestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-screening-preview' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await previewJobScreeningGate(
      ctx,
      params.jobId,
      body as ScreeningGatePreviewRequest,
    )
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
