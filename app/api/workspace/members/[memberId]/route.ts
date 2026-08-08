/** DELETE /api/workspace/members/[memberId] — admin removes a member */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { requireMembership, removeMember } from '@hire'

export const dynamic = 'force-dynamic'

export const DELETE = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-members-rm' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await removeMember(ctx, params.memberId)
    return NextResponse.json({ ok: true })
  },
})
