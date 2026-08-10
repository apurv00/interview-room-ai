/**
 * POST /api/workspace/applications/[appId]/stage — advance or reject.
 * Every move records the acting member + timestamp in the application's
 * event log; marking Hired requires a decision note. The AI never calls this.
 */

import { NextResponse } from 'next/server'
import { requireMembership, moveStage, MoveStageSchema, type MoveStagePayload } from '@hire'
import { serializeApplication } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<MoveStagePayload>({
  schema: MoveStageSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-stage' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const application = await moveStage(ctx, params.appId, body)
    return NextResponse.json({ application: serializeApplication(application) })
  },
})
