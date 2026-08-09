/**
 * GET /api/workspace/applications/[appId] — the candidate card.
 *
 * Opening the card is the moment fresh results matter, so this read first
 * runs the completion-event reconciliation (roundLinkService — read-only
 * against the engine, atomic claim on the hire side), then returns the
 * application, candidate, job, rounds, and any transient activity
 * ("interview in progress right now").
 *
 * Guests whose round completed in this pass are RETIRED here (engine-run
 * budget → 0): the round is done, so neither retake farming nor the
 * engine's calendar-month counter reset can buy more runs on the same
 * invite (Codex P2 on #606). The B2C write lives in this app-layer route —
 * the hire module itself never writes B2C rows.
 */

import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
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
  // Account-lifecycle egress fence: a deleted/deleting account with a
  // still-valid JWT must not read or mutate hiring data (Codex P1 on #604).
  requireActiveAccount: true,
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { activity, completedGuestUserIds } = await reconcileApplicationRounds(
      ctx.workspace._id.toString(),
      params.appId
    )
    if (completedGuestUserIds.length > 0) {
      await connectDB()
      await User.updateMany(
        { _id: { $in: completedGuestUserIds } },
        { $set: { monthlyInterviewLimit: 0 } }
      )
    }
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
