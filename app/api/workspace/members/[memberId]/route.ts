/** DELETE /api/workspace/members/[memberId] — admin removes a member */

import { NextResponse } from 'next/server'
import { requireMembership, removeMember } from '@hire'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const DELETE = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-members-rm' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await removeMember(ctx, params.memberId)
    return NextResponse.json({ ok: true })
  },
})
