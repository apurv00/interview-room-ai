/** POST — duplicate a job's JD/configuration into a fresh requisition. */

import { NextResponse } from 'next/server'
import {
  duplicateJob,
  requireMembership,
  DuplicateJobSchema,
  type DuplicateJobPayload,
} from '@hire'
import { serializeJob } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/**
 * The raw public-apply capability is returned on this authenticated response
 * only. The created job stores its sha256 hash, never the capability itself.
 */
export const POST = composeHireApiRoute<DuplicateJobPayload>({
  schema: DuplicateJobSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-job-duplicate' },
  async handler(_req, { user, params, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { job, capability } = await duplicateJob(ctx, params.jobId, body)
    return NextResponse.json(
      {
        job: serializeJob(job, { includeJd: true }),
        capability,
      },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
