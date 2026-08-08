/**
 * GET  /api/workspace/members — list the HR team
 * POST /api/workspace/members — admin adds a member by name + email
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  requireMembership,
  addMember,
  listMembers,
  AddMemberSchema,
  type AddMemberPayload,
} from '@hire'
import { serializeMember } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-members' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const members = await listMembers(ctx)
    return NextResponse.json({ members: members.map(serializeMember) })
  },
})

export const POST = composeApiRoute<AddMemberPayload>({
  schema: AddMemberSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-members-add' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const member = await addMember(ctx, body)
    return NextResponse.json({ member: serializeMember(member) }, { status: 201 })
  },
})
