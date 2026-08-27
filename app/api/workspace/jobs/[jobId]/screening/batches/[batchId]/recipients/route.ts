import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { readJobScreeningBatchRecipients } from '@hire-operations'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../../../../../_lib/composeHireApiRoute'
import {
  decodeScreeningRecipientCursor,
  encodeScreeningRecipientCursor,
} from '../../../_lib/paging'

export const dynamic = 'force-dynamic'

function queryOf(request: Request): { limit: number; cursor: string | null } {
  const search = new URL(request.url).searchParams
  for (const key of Array.from(search.keys())) {
    if (!['cursor', 'limit'].includes(key) || search.getAll(key).length !== 1) {
      throw new AppError('Invalid screening recipient query', 400, 'INVALID_QUERY')
    }
  }
  const rawLimit = search.get('limit')
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    throw new AppError('Invalid screening recipient limit', 400, 'INVALID_LIMIT')
  }
  const limit = rawLimit === null ? 25 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError('Screening recipient limit must be 1-50', 400, 'INVALID_LIMIT')
  }
  return { limit, cursor: search.get('cursor') }
}

/** Member-only, bounded delivery detail for one job-scoped invitation batch. */
export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:hire-screening-batch-recipients',
  },
  async handler(req, { user, params }) {
    const query = queryOf(req)
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const scope = {
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      memberId: ctx.membership._id.toString(),
      batchId: params.batchId,
    }
    const page = await readJobScreeningBatchRecipients(
      ctx,
      params.jobId,
      params.batchId,
      {
        limit: query.limit,
        cursor: decodeScreeningRecipientCursor(
          query.cursor,
          scope,
          query.limit,
        ),
      },
    )
    return NextResponse.json({
      ...page,
      nextCursor: page.nextCursor
        ? encodeScreeningRecipientCursor(page.nextCursor, scope, query.limit)
        : null,
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
