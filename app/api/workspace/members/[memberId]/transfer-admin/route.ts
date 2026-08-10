/** POST — transfer the workspace's single admin role to an active member. */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  transferWorkspaceAdmin,
} from '@hire/services/workspaceService'
import {
  TransferWorkspaceAdminSchema,
  type TransferWorkspaceAdminPayload,
} from '@hire/validators/hire'
import { serializeMembership } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<TransferWorkspaceAdminPayload>({
  schema: TransferWorkspaceAdminSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-admin-transfer' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const updated = await transferWorkspaceAdmin(ctx, params.memberId, body)
    return NextResponse.json(serializeMembership(updated))
  },
})
