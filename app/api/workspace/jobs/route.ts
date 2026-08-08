/**
 * GET  /api/workspace/jobs — jobs with per-stage application counts
 * POST /api/workspace/jobs — create a job (title + JD)
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  requireMembership,
  createJob,
  listJobs,
  CreateJobSchema,
  type CreateJobPayload,
} from '@hire'
import { serializeJob, serializeJobListItem } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-jobs' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const jobs = await listJobs(ctx)
    return NextResponse.json({ jobs: jobs.map(serializeJobListItem) })
  },
})

export const POST = composeApiRoute<CreateJobPayload>({
  schema: CreateJobSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-jobs-create' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const job = await createJob(ctx, body)
    return NextResponse.json({ job: serializeJob(job, { includeJd: true }) }, { status: 201 })
  },
})
