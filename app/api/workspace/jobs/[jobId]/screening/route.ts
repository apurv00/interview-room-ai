import { NextResponse } from 'next/server'
import { listJobScreeningGates, requireMembership } from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'
import { serializeScreeningGate } from './_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-screening-list' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const gates = await listJobScreeningGates(ctx, params.jobId)
    return NextResponse.json(
      { gates: gates.map((item) => serializeScreeningGate(item.gate, item.batches)) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
