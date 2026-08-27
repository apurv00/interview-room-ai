import { NextRequest, NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { AppError } from '@shared/errors'
import {
  HireCandidateBulkOperationIssueQuerySchema,
  getHireCandidateBulkOperation,
} from '@/modules/hire-candidate-actions'
import {
  composeHireApiRoute,
  type HireApiContext,
} from '../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

function issueQuery(req: NextRequest) {
  const raw: Record<string, string> = {}
  for (const key of Array.from(req.nextUrl.searchParams.keys())) {
    const values = req.nextUrl.searchParams.getAll(key)
    if (!['cursor', 'limit'].includes(key) || values.length !== 1) {
      throw new AppError('Invalid bulk operation issue query', 400, 'INVALID_QUERY')
    }
    raw[key] = values[0]
  }
  return HireCandidateBulkOperationIssueQuerySchema.parse(raw)
}

async function readOperation(
  req: NextRequest,
  { user, params }: HireApiContext<unknown>,
): Promise<NextResponse> {
  const issues = issueQuery(req)
  const ctx = await requireMembership({ userId: user.id, email: user.email })
  const result = await getHireCandidateBulkOperation(ctx, {
    jobId: params.jobId,
    operationId: params.operationId,
    issues,
  })
  return NextResponse.json(result, { headers: PRIVATE_NO_STORE_HEADERS })
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 120,
    keyPrefix: 'rl:hire-candidate-bulk-read',
  },
  handler: readOperation,
})
