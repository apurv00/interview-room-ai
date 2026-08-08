/**
 * GET   /api/workspace — the caller's workspace + membership (null if none)
 * POST  /api/workspace — create a workspace; the creator becomes the admin
 * PATCH /api/workspace — admin updates settings (guest verification mode)
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
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

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-ws' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user }) {
    const ctx = await getWorkspaceForUser({ userId: user.id, email: user.email })
    if (!ctx) return NextResponse.json({ workspace: null, membership: null })
    return NextResponse.json(serializeMembership(ctx))
  },
})

export const POST = composeApiRoute<CreateWorkspacePayload>({
  schema: CreateWorkspaceSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-ws-create' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, body }) {
    const ctx = await createWorkspace(
      { userId: user.id, email: user.email },
      { name: body.name, guestAuthMode: body.guestAuthMode }
    )
    return NextResponse.json(serializeMembership(ctx), { status: 201 })
  },
})

export const PATCH = composeApiRoute<UpdateWorkspaceSettingsPayload>({
  schema: UpdateWorkspaceSettingsSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-ws-settings' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const workspace = await updateWorkspaceSettings(ctx, body)
    ctx.workspace = workspace
    return NextResponse.json(serializeMembership(ctx))
  },
})
