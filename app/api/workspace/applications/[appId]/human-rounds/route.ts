/**
 * POST /api/workspace/applications/[appId]/human-rounds
 *
 * HR either sends a guest-owned scorecard kit or logs a member-run interview.
 * This control-plane response intentionally omits the capability URL: the
 * public link only exists in the one-time email/recovery envelope and never
 * crosses this ordinary application API response.
 */

import { NextResponse } from 'next/server'
import {
  createGuestHumanRound,
  createMemberHumanRound,
  CreateHumanRoundSchema,
  requireMembership,
  type CreateHumanRoundPayload,
} from '@hire'
import { serializeHumanRound } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<CreateHumanRoundPayload>({
  schema: CreateHumanRoundSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-human-round-create' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    if (body.mode === 'guest_kit') {
      const result = await createGuestHumanRound(ctx, {
        applicationId: params.appId,
        interviewerName: body.interviewerName,
        interviewerEmail: body.interviewerEmail,
        operationId: body.operationId,
      })
      return NextResponse.json(
        {
          humanRound: serializeHumanRound(result.humanRound),
          deliveryQueued: result.deliveryQueued,
        },
        { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const humanRound = await createMemberHumanRound(ctx, {
      applicationId: params.appId,
      operationId: body.operationId,
    })
    return NextResponse.json(
      { humanRound: serializeHumanRound(humanRound) },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
