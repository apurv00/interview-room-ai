/**
 * GET  — bounded, server-filtered candidate page for this workspace job.
 * POST — add or merge a workspace candidate onto this one job.
 */

import { NextResponse } from 'next/server'
import {
  addOrMergeJobCandidate,
  AddOrMergeJobCandidateSchema,
  requireMembership,
  type AddOrMergeJobCandidatePayload,
} from '@hire'
import { serializeApplication, serializeCandidate } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'
import {
  HireJobCandidatesQuerySchema,
  HireOperationsJobParamsSchema,
  readHireJobCandidates,
} from '@hire-operations'

export const dynamic = 'force-dynamic'

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
    keyPrefix: 'rl:hire-job-candidate-list',
  },
  async handler(request, { user, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({ jobId: params.jobId })
    // Parsing the complete query object makes unknown and repeated parameters
    // fail closed instead of being silently ignored or taking the last value.
    const query = HireJobCandidatesQuerySchema.parse(
      rawSearchParams(new URL(request.url)),
    )
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const page = await readHireJobCandidates({
      workspaceId: ctx.workspace._id.toString(),
      jobId,
      query,
    })
    return NextResponse.json(page, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})

/**
 * This is intentionally job-scoped rather than a composition of the generic
 * candidate and application endpoints: it resolves the workspace email and
 * the per-job application in one server-side transaction.
 */
export const POST = composeHireApiRoute<AddOrMergeJobCandidatePayload>({
  schema: AddOrMergeJobCandidateSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-job-candidate-merge' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await addOrMergeJobCandidate(ctx, params.jobId, body)
    const terminal =
      result.status === 'already_considered' || result.status === 'already_decided'
    return NextResponse.json(
      {
        status: result.status,
        candidate: serializeCandidate(result.candidate),
        application: serializeApplication(result.application),
        createdCandidate: result.createdCandidate,
        createdApplication: result.createdApplication,
        sourceMerged: result.sourceMerged,
      },
      {
        status: terminal ? 409 : result.createdApplication ? 201 : 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
