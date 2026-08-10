/** POST /api/workspace/applications — put a candidate on a job */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  createApplication,
  CreateApplicationSchema,
  type CreateApplicationPayload,
} from '@hire'
import { serializeApplication } from '../_lib/serialize'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<CreateApplicationPayload>({
  schema: CreateApplicationSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-apps-create' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const application = await createApplication(ctx, body)
    return NextResponse.json({ application: serializeApplication(application) }, { status: 201 })
  },
})
