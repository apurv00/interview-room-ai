/** POST — cancel a workspace deletion during its 30-day recovery window. */

import { NextResponse } from 'next/server'
import {
  requireWorkspaceLifecycleMembership,
  restoreWorkspace,
} from '@hire/services/workspaceService'
import {
  RestoreWorkspaceSchema,
  type RestoreWorkspacePayload,
} from '@hire/validators/hire'
import { serializeMembership } from '../../_lib/serialize'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<RestoreWorkspacePayload>({
  schema: RestoreWorkspaceSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-workspace-restore' },
  async handler(_req, { user, body }) {
    const ctx = await requireWorkspaceLifecycleMembership({
      userId: user.id,
      email: user.email,
    })
    ctx.workspace = await restoreWorkspace(ctx, body)
    return NextResponse.json(serializeMembership(ctx))
  },
})
