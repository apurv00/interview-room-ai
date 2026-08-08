/** POST /api/workspace/applications — put a candidate on a job */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  requireMembership,
  createApplication,
  CreateApplicationSchema,
  type CreateApplicationPayload,
} from '@hire'
import { serializeApplication } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export const POST = composeApiRoute<CreateApplicationPayload>({
  schema: CreateApplicationSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-apps-create' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const application = await createApplication(ctx, body)
    return NextResponse.json({ application: serializeApplication(application) }, { status: 201 })
  },
})
