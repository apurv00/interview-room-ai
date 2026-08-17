import { NextResponse } from 'next/server'
import {
  requireMembership,
  issueApplyLink,
  disableApplyLink,
  recoverApplyLink,
} from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/**
 * Apply-link management for a job. GET returns the active public link only
 * to an authenticated workspace member; POST issues (or rotates) it; DELETE
 * turns it off.
 *
 * Raw capability material is never cacheable. Replacing a link is also its
 * revocation mechanism: a shared URL cannot be un-shared, only killed.
 */
function privateResponse(body: object) {
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-apply-link-read' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    return privateResponse({ capability: await recoverApplyLink(ctx, params.jobId) })
  },
})

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { capability } = await issueApplyLink(ctx, params.jobId)
    return privateResponse({ capability, enabled: true })
  },
})

export const DELETE = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-apply-link-off' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await disableApplyLink(ctx, params.jobId)
    return privateResponse({ enabled: false })
  },
})
