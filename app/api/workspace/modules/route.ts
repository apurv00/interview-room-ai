/** Admin-only, read-only commercial module catalog. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire-operations-boundary'
import { readHireCommercialWorkspace } from '@hire-commercial'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:hire-commercial-modules',
  },
  async handler(_request, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const commercial = await readHireCommercialWorkspace(ctx)
    return NextResponse.json(commercial, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
