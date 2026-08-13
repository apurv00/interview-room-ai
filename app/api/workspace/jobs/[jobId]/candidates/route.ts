/** POST — add or merge a workspace candidate onto this one job. */

import { NextResponse } from 'next/server'
import {
  addOrMergeJobCandidate,
  AddOrMergeJobCandidateSchema,
  requireMembership,
  type AddOrMergeJobCandidatePayload,
} from '@hire'
import { serializeApplication, serializeCandidate } from '../../../_lib/serialize'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

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
