import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { retryFailedHireMultimodalAnalysis } from '@modules/hire-multimodal/services/analysisRecoveryService'
import { composeHireApiRoute } from '../../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:hire-multimodal-analysis-retry',
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await retryFailedHireMultimodalAnalysis({
      workspaceId: ctx.workspace._id.toString(),
      authorityMemberId: ctx.membership._id.toString(),
      applicationId: params.appId,
      analysisId: params.analysisId,
    })
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
