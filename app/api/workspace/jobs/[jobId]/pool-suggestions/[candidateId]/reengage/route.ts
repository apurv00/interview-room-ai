import { NextResponse } from 'next/server'
import {
  reengagePoolCandidate,
  ReengagePoolCandidateSchema,
  requireMembership,
  type ReengagePoolCandidatePayload,
} from '@hire'
import { composeHireApiRoute } from '../../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/** Explicit HR confirmation; no candidate is added or emailed by GET/list. */
export const POST = composeHireApiRoute<ReengagePoolCandidatePayload>({
  schema: ReengagePoolCandidateSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-pool-reengage' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await reengagePoolCandidate(ctx, params.jobId, {
      candidateId: params.candidateId,
      operationId: body.operationId,
    })
    const conflict = result.status !== 'queued'
    return NextResponse.json(result, {
      status: conflict ? 409 : 201,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
