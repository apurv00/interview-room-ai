/**
 * GET   /api/workspace/jobs/[jobId] — job + full pipeline (cards by stage)
 * PATCH /api/workspace/jobs/[jobId] — open / hold / close (close needs a note)
 * DELETE /api/workspace/jobs/[jobId] — permanently remove a pristine job only
 */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  getJobCloseEmailDelivery,
  getJobPipeline,
  updateJobStatus,
  UpdateJobStatusSchema,
  type UpdateJobStatusPayload,
} from '@hire'
import {
  serializeJob,
  serializeJobEmailDelivery,
  serializePipelineEntry,
} from '../../_lib/serialize'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'
import {
  DeleteEmptyHireJobSchema,
  deleteEmptyHireJob,
  type DeleteEmptyHireJobPayload,
} from '@/modules/hire-job-deletion'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-job' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const [pipeline, emailDelivery] = await Promise.all([
      getJobPipeline(ctx, params.jobId),
      getJobCloseEmailDelivery(ctx, params.jobId),
    ])
    return NextResponse.json({
      job: serializeJob(pipeline.job, { includeJd: true }),
      entries: pipeline.entries.map(serializePipelineEntry),
      emailDelivery: serializeJobEmailDelivery(emailDelivery),
    })
  },
})

export const PATCH = composeHireApiRoute<UpdateJobStatusPayload>({
  schema: UpdateJobStatusSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-job-status' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const job = await updateJobStatus(ctx, params.jobId, body)
    return NextResponse.json({ job: serializeJob(job) })
  },
})

/**
 * This never cascades into candidate data or external artifacts. The command
 * succeeds only for a non-terminal job with no downstream hiring activity;
 * populated jobs must use the explicit close lifecycle instead.
 */
export const DELETE = composeHireApiRoute<DeleteEmptyHireJobPayload>({
  schema: DeleteEmptyHireJobSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-job-delete' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const deleted = await deleteEmptyHireJob(ctx, params.jobId, body)
    return NextResponse.json(
      { deleted: true, jobId: deleted.jobId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
