/** POST — safely requeue this job's terminal close-rejection email failures. */

import { NextResponse } from 'next/server'
import { requireMembership, retryFailedJobCloseEmails } from '@hire'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-email-retry' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await retryFailedJobCloseEmails(ctx, params.jobId)
    return NextResponse.json(result)
  },
})
