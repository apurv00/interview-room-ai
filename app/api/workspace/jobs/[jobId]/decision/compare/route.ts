/** Member-only comparison of 2–3 deliberately selected applications. */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireMembership } from '@hire'
import { compareHireDecisionApplications } from '@hire-decisions'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'

const CompareSchema = z.object({
  applicationIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid application id'))
    .min(2, 'Choose at least two candidates')
    .max(3, 'Compare at most three candidates')
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each candidate once'),
}).strict()

type ComparePayload = z.infer<typeof CompareSchema>

export const dynamic = 'force-dynamic'

export const POST = composeHireApiRoute<ComparePayload>({
  schema: CompareSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-decision-compare' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const comparison = await compareHireDecisionApplications({
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      applicationIds: body.applicationIds,
    })
    return NextResponse.json(comparison, { headers: { 'Cache-Control': 'private, no-store' } })
  },
})
