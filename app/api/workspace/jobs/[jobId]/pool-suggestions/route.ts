import { NextResponse } from 'next/server'
import { listJobPoolSuggestions, requireMembership } from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/**
 * Recruiter-only read model for past candidates. The service never returns a
 * resume and this route never changes applications or sends email.
 */
export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-pool-suggestions' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const suggestions = await listJobPoolSuggestions(ctx, params.jobId)
    return NextResponse.json(
      { suggestions },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
