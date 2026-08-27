import { NextResponse } from 'next/server'
import {
  listJobScreeningGates,
  requireMembership,
} from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'
import { serializeScreeningGate } from './_lib/serialize'
import { AppError } from '@shared/errors'
import {
  decodeScreeningHistoryCursor,
  encodeScreeningBatchCursor,
  encodeScreeningHistoryCursor,
} from './_lib/paging'

export const dynamic = 'force-dynamic'

function historyQuery(request: Request): { limit: number; cursor: string | null } {
  const search = new URL(request.url).searchParams
  for (const key of Array.from(search.keys())) {
    if (!['cursor', 'limit'].includes(key) || search.getAll(key).length !== 1) {
      throw new AppError('Invalid screening history query', 400, 'INVALID_QUERY')
    }
  }
  const rawLimit = search.get('limit')
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    throw new AppError('Invalid screening history limit', 400, 'INVALID_LIMIT')
  }
  const limit = rawLimit === null ? 10 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new AppError('Screening history limit must be 1-25', 400, 'INVALID_LIMIT')
  }
  return { limit, cursor: search.get('cursor') }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-screening-list' },
  async handler(request, { user, params }) {
    const query = historyQuery(request)
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const scope = {
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      memberId: ctx.membership._id.toString(),
    }
    const page = await listJobScreeningGates(ctx, params.jobId, {
      limit: query.limit,
      cursor: decodeScreeningHistoryCursor(query.cursor, scope, query.limit),
    })
    return NextResponse.json(
      {
        gates: page.items.map((item) => {
          const gate = serializeScreeningGate(
            item.gate,
            item.batches,
            item.hasMoreBatches,
          )
          const lastBatch = item.batches[item.batches.length - 1]
          return {
            ...gate,
            batchPageInfo: {
              limit: 10,
              hasNextPage: item.hasMoreBatches,
              nextCursor: item.hasMoreBatches && lastBatch
                ? encodeScreeningBatchCursor(
                    { wave: lastBatch.wave, id: lastBatch._id.toString() },
                    { ...scope, gateId: item.gate._id.toString() },
                    10,
                  )
                : null,
            },
          }
        }),
        pageInfo: {
          limit: query.limit,
          hasNextPage: page.nextCursor !== null,
          nextCursor: page.nextCursor
            ? encodeScreeningHistoryCursor(page.nextCursor, scope, query.limit)
            : null,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
