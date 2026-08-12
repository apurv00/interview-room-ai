import { NextResponse } from 'next/server'
import {
  HireInterviewAttempt,
  HireInterviewResult,
  HireMediaAsset,
  requireMembership,
  getApplicationDetail,
  getAiInviteDeliveryViews,
} from '@hire'
import {
  serializeApplication,
  serializeCandidate,
  serializeJob,
  serializeRound,
  resumeHashOf,
} from '../../_lib/serialize'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

/** Candidate card reads only workspace-owned Hire projections and media ids. */
export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-app' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const detail = await getApplicationDetail(ctx, params.appId)
    const roundIds = detail.rounds.map((round) => round._id)
    const scope = {
      workspaceId: ctx.workspace._id,
      applicationId: detail.application._id,
      roundId: { $in: roundIds },
    }
    const [results, photos, attempts, inviteDeliveryByRound] = await Promise.all([
      HireInterviewResult.find(scope)
        .select(
          'roundId attemptId numericSummary projection evidenceIndex completedAt piiPurgedAt',
        )
        .lean(),
      HireMediaAsset.find({
        ...scope,
        kind: 'identity_photo',
        state: 'ready',
        active: true,
      })
        .select('_id roundId attemptId capturedAt')
        .lean(),
      HireInterviewAttempt.find(scope)
        .select('roundId status startedAt completedAt sequence')
        .lean(),
      getAiInviteDeliveryViews(ctx, detail.rounds),
    ])
    const resultByRound = new Map(results.map((result) => [result.roundId.toString(), result]))
    const photoByRound = new Map(photos.map((photo) => [photo.roundId.toString(), photo]))

    return NextResponse.json({
      application: serializeApplication(detail.application, {
        candidateResumeHash: resumeHashOf(detail.candidate.resumeText),
        includeApplicantResume: true,
      }),
      candidate: serializeCandidate(detail.candidate, { includeResume: true }),
      job: serializeJob(detail.job, { includeJd: true }),
      rounds: detail.rounds.map((round) => {
        const serialized = serializeRound(round)
        const result = resultByRound.get(round._id.toString())
        const photo = photoByRound.get(round._id.toString())
        return {
          ...serialized,
          inviteDelivery: inviteDeliveryByRound.get(round._id.toString()) ?? null,
          assessment: result?.projection ?? null,
          evidenceIndex: result?.evidenceIndex ?? [],
          identityPhoto: photo
            ? { assetId: photo._id.toString(), capturedAt: photo.capturedAt }
            : null,
          mediaPurged: Boolean(result?.piiPurgedAt),
        }
      }),
      activity: attempts.map((attempt) => ({
        roundId: attempt.roundId.toString(),
        inProgress: attempt.status === 'in_progress' || attempt.status === 'processing',
        status: attempt.status,
      })),
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
