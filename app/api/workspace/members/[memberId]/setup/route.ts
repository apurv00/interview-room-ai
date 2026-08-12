/** POST — replace and resend a pending direct member's password setup link. */

import { NextResponse } from 'next/server'
import {
  regenerateMemberSetup,
  requireMembership,
} from '@hire/services/workspaceService'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-member-setup' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const setup = await regenerateMemberSetup(ctx, params.memberId)
    return NextResponse.json(
      {
        credentialSetup: {
          url: setup.setupUrl,
          expiresAt: setup.expiresAt,
          emailSent: setup.emailSent,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
