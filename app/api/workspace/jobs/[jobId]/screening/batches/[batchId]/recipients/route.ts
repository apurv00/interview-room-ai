import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { readJobScreeningBatchRecipients } from '@hire-operations'
import { composeHireApiRoute } from '../../../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/** Member-only, bounded delivery detail for one job-scoped invitation batch. */
export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:hire-screening-batch-recipients',
  },
  async handler(req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const search = new URL(req.url).searchParams
    const cursor = search.get('cursor') ?? undefined
    const rawLimit = search.get('limit')
    const page = await readJobScreeningBatchRecipients(
      ctx,
      params.jobId,
      params.batchId,
      {
        ...(cursor ? { cursor } : {}),
        ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
      },
    )
    return NextResponse.json(page, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
