/** PATCH — admin reassigns a job without invoking its lifecycle transition. */

import { NextResponse } from 'next/server'
import {
  requireMembership,
  updateJobDepartment,
  UpdateJobDepartmentSchema,
  type UpdateJobDepartmentPayload,
} from '@hire'
import { serializeJob } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

export const PATCH = composeHireApiRoute<UpdateJobDepartmentPayload>({
  schema: UpdateJobDepartmentSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:hire-job-department' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const job = await updateJobDepartment(ctx, params.jobId, body)
    return NextResponse.json({ job: serializeJob(job) })
  },
})
