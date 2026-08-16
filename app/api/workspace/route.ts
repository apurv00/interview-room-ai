/**
 * GET   /api/workspace — the caller's workspace + membership (null if none)
 * POST  /api/workspace — create a workspace; the creator becomes the admin
 * PATCH /api/workspace — admin updates settings (guest verification mode)
 */

import { NextResponse } from 'next/server'
import { composeHireApiRoute } from './_lib/composeHireApiRoute'
import {
  createWorkspace,
  getWorkspaceForUser,
  requireMembership,
  updateWorkspaceSettings,
  CreateWorkspaceSchema,
  UpdateWorkspaceSettingsSchema,
  type CreateWorkspacePayload,
  type UpdateWorkspaceSettingsPayload,
} from '@hire'
import { serializeMembership } from './_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-ws' },
  async handler(_req, { user }) {
    const ctx = await getWorkspaceForUser({ userId: user.id, email: user.email })
    if (!ctx) return NextResponse.json({ workspace: null, membership: null })
    return NextResponse.json(serializeMembership(ctx))
  },
})

export const POST = composeHireApiRoute<CreateWorkspacePayload>({
  schema: CreateWorkspaceSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-ws-create' },
  async handler(_req, { user, body }) {
    const ctx = await createWorkspace(
      { userId: user.id, email: user.email },
      {
        name: body.name,
        companyDescription: body.companyDescription,
        guestAuthMode: body.guestAuthMode,
      }
    )
    return NextResponse.json(serializeMembership(ctx), { status: 201 })
  },
})

export const PATCH = composeHireApiRoute<UpdateWorkspaceSettingsPayload>({
  schema: UpdateWorkspaceSettingsSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-ws-settings' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const workspace = await updateWorkspaceSettings(ctx, body)
    ctx.workspace = workspace
    return NextResponse.json(serializeMembership(ctx))
  },
})
