/**
 * POST /api/workspace/applications/[appId]/rounds — send an AI interview.
 * Creates the round (token hashed at rest, 7-day expiry), emails the invite,
 * and records the send in the application's event log. Returns the invite
 * URL so the member can copy it if email delivery is unavailable.
 */

import { NextResponse } from 'next/server'
import { requireMembership, sendAiRound, SendAiRoundSchema, type SendAiRoundPayload } from '@hire'
import { serializeRound } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<SendAiRoundPayload>({
  schema: SendAiRoundSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-round-send' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await sendAiRound(ctx, {
      applicationId: params.appId,
      experience: body.experience,
      duration: body.duration,
    })
    return NextResponse.json(
      {
        round: serializeRound(result.round),
        inviteUrl: result.inviteUrl,
        emailSent: result.emailSent,
      },
      { status: 201 }
    )
  },
})
