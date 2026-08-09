import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { requireMembership, issueApplyLink, disableApplyLink } from '@hire'

export const dynamic = 'force-dynamic'

/**
 * Apply-link management for a job. POST issues (or rotates) the public
 * link; DELETE turns it off.
 *
 * The raw token is returned exactly ONCE, at mint time — only its sha256
 * is stored, so nothing can hand it back later. Rotating is therefore also
 * the revocation mechanism: a shared URL cannot be un-shared, only killed.
 */
export const POST = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link' },
  requireActiveAccount: true,
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { token } = await issueApplyLink(ctx, params.jobId)
    return NextResponse.json({ token, enabled: true })
  },
})

export const DELETE = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link-off' },
  requireActiveAccount: true,
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await disableApplyLink(ctx, params.jobId)
    return NextResponse.json({ enabled: false })
  },
})
