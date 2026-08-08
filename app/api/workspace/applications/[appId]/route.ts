/**
 * GET /api/workspace/applications/[appId] — the candidate card.
 *
 * Opening the card is the moment fresh results matter, so this read first
 * runs the completion-event reconciliation (roundLinkService — read-only
 * against the engine, atomic claim on the hire side), then returns the
 * application, candidate, job, rounds, and any transient activity
 * ("interview in progress right now").
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { requireMembership, getApplicationDetail, reconcileApplicationRounds } from '@hire'
import {
  serializeApplication,
  serializeCandidate,
  serializeJob,
  serializeRound,
} from '../../_lib/serialize'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-app' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const activity = await reconcileApplicationRounds(
      ctx.workspace._id.toString(),
      params.appId
    )
    const detail = await getApplicationDetail(ctx, params.appId)
    return NextResponse.json({
      application: serializeApplication(detail.application),
      candidate: serializeCandidate(detail.candidate, { includeResume: true }),
      job: serializeJob(detail.job, { includeJd: true }),
      rounds: detail.rounds.map(serializeRound),
      activity,
    })
  },
})
