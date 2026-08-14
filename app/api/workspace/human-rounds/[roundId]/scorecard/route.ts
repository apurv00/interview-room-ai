/** POST /api/workspace/human-rounds/[roundId]/scorecard — submit the current member's own draft. */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  submitMemberHumanRoundScorecard,
  SubmitHumanRoundScorecardSchema,
  type SubmitHumanRoundScorecardPayload,
} from '@hire'
import { serializeHumanRound } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<SubmitHumanRoundScorecardPayload>({
  schema: SubmitHumanRoundScorecardSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-human-scorecard-submit' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const humanRound = await submitMemberHumanRoundScorecard(ctx, {
      humanRoundId: params.roundId,
      dimensions: body.dimensions,
      recommendation: body.recommendation,
      overallComment: body.overallComment,
    })
    return NextResponse.json(
      { humanRound: serializeHumanRound(humanRound) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
