/** POST — schedule a recoverable workspace deletion and revoke public links. */

import { NextResponse } from 'next/server'
import {
  requireWorkspaceLifecycleMembership,
  softDeleteWorkspace,
} from '@hire/services/workspaceService'
import {
  SoftDeleteWorkspaceSchema,
  type SoftDeleteWorkspacePayload,
} from '@hire/validators/hire'
import { serializeMembership } from '../../_lib/serialize'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<SoftDeleteWorkspacePayload>({
  schema: SoftDeleteWorkspaceSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-workspace-delete' },
  async handler(_req, { user, body }) {
    const ctx = await requireWorkspaceLifecycleMembership({
      userId: user.id,
      email: user.email,
    })
    ctx.workspace = await softDeleteWorkspace(ctx, body)
    return NextResponse.json(serializeMembership(ctx))
  },
})
