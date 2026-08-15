/** POST /api/workspace/candidate-status-links/[linkId]/revoke — member-only revoke. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import { revokeCandidateStatusLink } from '@/modules/hire-status/services/candidateStatusLinkService'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-candidate-status-link-revoke',
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const candidateStatusLink = await revokeCandidateStatusLink({
      authority: {
        workspaceId: ctx.workspace._id.toString(),
        memberId: ctx.membership._id.toString(),
        memberName: ctx.membership.name || ctx.membership.email,
      },
      linkId: params.linkId,
    })
    return NextResponse.json(
      { candidateStatusLink },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
