import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import {
  requireMembership,
  adjudicateSubmission,
  AdjudicateSubmissionSchema,
  type AdjudicateSubmissionPayload,
} from '@hire'

export const dynamic = 'force-dynamic'

/**
 * Recruiter adjudication of public apply-page submissions.
 *
 * Anonymous callers can only ADD documents, so a workspace needs a way to
 * settle a contested candidate: promote the authentic résumé to the pool
 * record, or delete a fraudulent one. This is the only path that removes
 * evidence, and it is member-attributed and audited for exactly that
 * reason — it also serves erasure requests for a person whose résumé was
 * submitted without their involvement.
 */
export const POST = composeApiRoute<AdjudicateSubmissionPayload>({
  schema: AdjudicateSubmissionSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-submission-adj' },
  requireActiveAccount: true,
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    await adjudicateSubmission(ctx, params.appId, body)
    return NextResponse.json({ ok: true })
  },
})
