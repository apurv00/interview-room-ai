import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { readCandidateSelectionSnapshot } from '@hire-operations'
import {
  CreateHireCandidateBulkOperationSchema,
  createHireCandidateBulkOperation,
  type CreateHireCandidateBulkOperationInput,
} from '@/modules/hire-candidate-actions'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

/**
 * Start one durable operation from a server-owned immutable selection. The
 * request carries no authoritative application-id list, and 202 means only
 * that the operation was durably accepted—not that every row has succeeded.
 */
export const POST = composeHireApiRoute<CreateHireCandidateBulkOperationInput>({
  schema: CreateHireCandidateBulkOperationSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-candidate-bulk-create',
  },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const operation = await createHireCandidateBulkOperation(
      ctx,
      { ...body, jobId: params.jobId },
      readCandidateSelectionSnapshot,
    )
    return NextResponse.json(
      { operation },
      { status: 202, headers: PRIVATE_NO_STORE_HEADERS },
    )
  },
})
