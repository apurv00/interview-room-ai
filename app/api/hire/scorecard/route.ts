import { NextResponse } from 'next/server'
import { z } from 'zod'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { getHireUser, isRecruiter } from '@b2b/services/hireService'
import { getRecruiterScorecard } from '@b2b/services/scorecardService'

const ScorecardSchema = z.object({
  sessionId: z.string().min(1),
})

type ScorecardPayload = z.infer<typeof ScorecardSchema>

export const POST = composeApiRoute<ScorecardPayload>({
  schema: ScorecardSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-scorecard' },

  async handler(_req, { user, body }) {
    const hireUser = await getHireUser(user.id)
    if (!hireUser || !isRecruiter(hireUser)) {
      return NextResponse.json({ error: 'Recruiter access required' }, { status: 403 })
    }

    const scorecard = await getRecruiterScorecard(
      body.sessionId,
      hireUser.organizationId!.toString()
    )

    if (!scorecard) {
      return NextResponse.json({ error: 'Scorecard not found' }, { status: 404 })
    }

    return NextResponse.json({ scorecard })
  },
})
