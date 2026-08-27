import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { startHireInterviewAttempt } from '@hire/services/identityMediaService'
import { issueHireEngineHandoff } from '@hire/services/engineHandoffService'
import { HireRound } from '@hire/models/HireRound'
import { HireWorkspace } from '@hire/models/HireWorkspace'
import { hireHandoffIssuanceAllowed } from '../../_lib/hireHandoffIssuanceGate'
import { hireGuestErrorResponse, requireHireGuest } from '../../_lib/hireGuestHttp'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } },
) {
  if (!hireHandoffIssuanceAllowed(req.headers)) {
    return NextResponse.json(
      {
        error: 'Interview starts are temporarily paused',
        code: 'HANDOFF_ISSUANCE_PAUSED',
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'private, no-store',
          'Retry-After': '30',
        },
      },
    )
  }
  const blocked = await checkRateLimit(params.roundId, {
    windowMs: 60_000,
    maxRequests: 8,
    keyPrefix: 'rl:hire-attempt-start',
  })
  if (blocked) return blocked
  try {
    const scope = await requireHireGuest(req, params.roundId)
    const started = await startHireInterviewAttempt({ scope })
    const round = await HireRound.findOne({
      _id: scope.roundId,
      workspaceId: scope.workspaceId,
      applicationId: scope.applicationId,
      jobId: scope.jobId,
      candidateId: scope.candidateId,
      revokedAt: { $exists: false },
      status: { $nin: ['completed', 'revoked'] },
    })
      .select('config jdSnapshot consentVersion consentAt inviteTokenExpiry')
      .lean()
    const roundMatchesAttemptConsent =
      Boolean(round?.consentAt) &&
      round?.consentVersion === started.consent.consentVersion &&
      round.consentAt?.getTime() === started.consent.acceptedAt.getTime()
    if (!round || !roundMatchesAttemptConsent) {
      return NextResponse.json(
        { error: 'A matching consent receipt is required', code: 'CONSENT_REQUIRED' },
        { status: 409 },
      )
    }
    const workspace = await HireWorkspace.findOne({
      _id: scope.workspaceId,
      $or: [
        { lifecycleState: 'active' },
        { lifecycleState: { $exists: false } },
      ],
    })
      .select('name')
      .lean()
    if (!workspace) {
      return NextResponse.json(
        { error: 'This interview invitation is no longer valid', code: 'ROUND_INVALID' },
        { status: 410 },
      )
    }
    const experience = round.config.experience
    if (!['0-2', '3-6', '7+'].includes(experience)) {
      return NextResponse.json(
        { error: 'The interview configuration is invalid', code: 'ROUND_CONFIG_INVALID' },
        { status: 409 },
      )
    }
    const handoff = await issueHireEngineHandoff({
      workspaceId: scope.workspaceId,
      applicationId: scope.applicationId,
      roundId: scope.roundId,
      config: {
        role: round.config.role,
        interviewType: round.config.interviewType,
        experience: experience as '0-2' | '3-6' | '7+',
        duration: round.config.duration,
        jobDescription: round.jdSnapshot,
        targetCompany: workspace.name,
      },
      consentVersion: started.consent.consentVersion,
      consentAt: started.consent.acceptedAt,
      inviteExpiresAt: round.inviteTokenExpiry,
    })
    return NextResponse.json(
      {
        attemptId: started.attemptId,
        recordingEpoch: started.recordingEpoch.toISOString(),
        handoffUrl: handoff.handoffUrl,
        handoffExpiresAt: handoff.expiresAt.toISOString(),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    return hireGuestErrorResponse(error)
  }
}
