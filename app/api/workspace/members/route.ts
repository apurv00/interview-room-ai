/**
 * GET  /api/workspace/members — list the HR team
 * POST /api/workspace/members — admin adds a member by name + email
 */

import { NextResponse } from 'next/server'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'
import {
  requireMembership,
  addMember,
  listMembers,
  AddMemberSchema,
  type AddMemberPayload,
} from '@hire'
import { serializeMember } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-members' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const members = await listMembers(ctx)
    return NextResponse.json({ members: members.map(serializeMember) })
  },
})

export const POST = composeHireApiRoute<AddMemberPayload>({
  schema: AddMemberSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-members-add' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const provisioned = await addMember(ctx, body)
    return NextResponse.json(
      {
        member: serializeMember(provisioned.member),
        credentialSetup: {
          url: provisioned.setupUrl,
          expiresAt: provisioned.expiresAt,
          emailSent: provisioned.emailSent,
        },
      },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
