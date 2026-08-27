/**
 * Purpose-limited candidate identity search for deliberate comparison.
 *
 * Its service performs an identity-only, bounded, privacy-aware projection;
 * rank, JD score, stage, assessment summaries, and evidence never cross this
 * response boundary or enter this route.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireMembership } from '@hire'
import { readHireJobCandidateIdentities } from '@hire-operations'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const querySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid search'),
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(20),
  })
  .strict()

function rawSearchParams(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  url.searchParams.forEach((value, key) => {
    const existing = result[key]
    result[key] = existing === undefined
      ? value
      : Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
  })
  return result
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:hire-decision-candidate-search',
  },
  async handler(request, { user, params }) {
    if (!OBJECT_ID.test(params.jobId)) {
      throw new AppError('Invalid job id', 400, 'INVALID_ID')
    }
    const query = querySchema.parse(rawSearchParams(new URL(request.url)))
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const page = await readHireJobCandidateIdentities({
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      query: {
        q: query.q,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
    })

    return NextResponse.json(
      {
        candidates: page.candidates.map((candidate) => ({
          applicationId: candidate.applicationId,
          candidateName: candidate.candidateName,
          candidateEmail: candidate.candidateEmail,
        })),
        pageInfo: {
          limit: page.pageInfo.limit,
          nextCursor: page.pageInfo.nextCursor,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
