/** POST /api/workspace/human-rounds/[roundId]/revoke — revoke a human kit/round only. */

import { NextResponse } from 'next/server'
import { requireMembership, revokeHumanInterviewKit } from '@hire'
import { serializeHumanRound } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-human-round-revoke' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const humanRound = await revokeHumanInterviewKit(ctx, params.roundId)
    return NextResponse.json(
      { humanRound: serializeHumanRound(humanRound) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
