/** POST /api/workspace/rounds/[roundId]/revoke — kill an invite link. */

import { NextResponse } from 'next/server'
import { requireMembership, revokeRound } from '@hire'
import { serializeRound } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-round-revoke' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const round = await revokeRound(ctx, params.roundId)
    return NextResponse.json({ round: serializeRound(round) })
  },
})
