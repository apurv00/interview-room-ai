import { NextResponse } from 'next/server'
import { requireMembership, issueApplyLink, disableApplyLink } from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/**
 * Apply-link management for a job. POST issues (or rotates) the public
 * link; DELETE turns it off.
 *
 * The raw token is returned exactly ONCE, at mint time — only its sha256
 * is stored, so nothing can hand it back later. Rotating is therefore also
 * the revocation mechanism: a shared URL cannot be un-shared, only killed.
 */
export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { capability } = await issueApplyLink(ctx, params.jobId)
    return NextResponse.json({ capability, enabled: true })
  },
})

export const DELETE = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link-off' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await disableApplyLink(ctx, params.jobId)
    return NextResponse.json({ enabled: false })
  },
})
