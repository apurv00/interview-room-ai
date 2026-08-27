import { NextRequest, NextResponse } from 'next/server'
import { requireMembership } from '@hire'
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

async function readOperation(
  req: NextRequest,
  { user, params }: HireApiContext<unknown>,
): Promise<NextResponse> {
  const ctx = await requireMembership({ userId: user.id, email: user.email })
  const issues = HireCandidateBulkOperationIssueQuerySchema.parse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  )
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
