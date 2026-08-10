/**
 * GET  /api/workspace/candidates — workspace talent pool
 * POST /api/workspace/candidates — add a candidate manually
 */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  addCandidate,
  listCandidates,
  AddCandidateSchema,
  type AddCandidatePayload,
} from '@hire'
import { serializeCandidate } from '../_lib/serialize'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-cands' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const candidates = await listCandidates(ctx)
    return NextResponse.json({ candidates: candidates.map((c) => serializeCandidate(c)) })
  },
})

export const POST = composeHireApiRoute<AddCandidatePayload>({
  schema: AddCandidateSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-cands-add' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const candidate = await addCandidate(ctx, body)
    return NextResponse.json({ candidate: serializeCandidate(candidate) }, { status: 201 })
  },
})
