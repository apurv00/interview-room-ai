import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { readJobScreeningGateBatches } from '@hire-operations'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../../../../../_lib/composeHireApiRoute'
import { serializeInvitationBatch } from '../../../_lib/serialize'
import {
  decodeScreeningBatchCursor,
  encodeScreeningBatchCursor,
} from '../../../_lib/paging'

export const dynamic = 'force-dynamic'

function queryOf(request: Request): { limit: number; cursor: string | null } {
  const search = new URL(request.url).searchParams
  for (const key of Array.from(search.keys())) {
    if (!['cursor', 'limit'].includes(key) || search.getAll(key).length !== 1)
      throw new AppError('Invalid screening batch query', 400, 'INVALID_QUERY')
  }
  const raw = search.get('limit')
  if (raw !== null && !/^\d+$/.test(raw))
    throw new AppError('Invalid screening batch limit', 400, 'INVALID_LIMIT')
  const limit = raw === null ? 10 : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw new AppError('Screening batch limit must be 1-25', 400, 'INVALID_LIMIT')
  return { limit, cursor: search.get('cursor') }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-screening-batches' },
  async handler(request, { user, params }) {
    const query = queryOf(request)
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const scope = {
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      memberId: ctx.membership._id.toString(),
      gateId: params.gateId,
    }
    const page = await readJobScreeningGateBatches(
      ctx,
      params.jobId,
      params.gateId,
      {
        limit: query.limit,
        cursor: decodeScreeningBatchCursor(query.cursor, scope, query.limit),
      },
    )
    return NextResponse.json({
      batches: page.batches.map(serializeInvitationBatch),
      pageInfo: {
        limit: query.limit,
        hasNextPage: page.hasMore,
        nextCursor: page.nextCursor
          ? encodeScreeningBatchCursor(page.nextCursor, scope, query.limit)
          : null,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  },
})
