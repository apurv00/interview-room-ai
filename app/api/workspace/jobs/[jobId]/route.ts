/**
 * GET   /api/workspace/jobs/[jobId] — job + full pipeline (cards by stage)
 * PATCH /api/workspace/jobs/[jobId] — open / hold / close (close needs a note)
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  requireMembership,
  getJobPipeline,
  updateJobStatus,
  UpdateJobStatusSchema,
  type UpdateJobStatusPayload,
} from '@hire'
import { serializeJob, serializePipelineEntry } from '../../_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-job' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const pipeline = await getJobPipeline(ctx, params.jobId)
    return NextResponse.json({
      job: serializeJob(pipeline.job, { includeJd: true }),
      entries: pipeline.entries.map(serializePipelineEntry),
    })
  },
})

export const PATCH = composeApiRoute<UpdateJobStatusPayload>({
  schema: UpdateJobStatusSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-job-status' },
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const job = await updateJobStatus(ctx, params.jobId, body)
    return NextResponse.json({ job: serializeJob(job) })
  },
})
