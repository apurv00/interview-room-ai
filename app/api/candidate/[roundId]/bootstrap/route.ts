import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyRoundToken } from '@hire/services/aiRoundService'
import { HireConsentReceipt } from '@hire/models/HireConsentReceipt'
import {
  HireInterviewAttempt,
  type IHireInterviewAttempt,
} from '@hire/models/HireInterviewAttempt'
import { HireJob } from '@hire/models/HireJob'
import { HireWorkspace } from '@hire/models/HireWorkspace'
import type { IHireRound } from '@hire/models/HireRound'
import {
  HIRE_AI_CONSENT_VERSION,
  isRecognizedHireConsentSnapshot,
} from '@hire/policies/aiInterviewConsent'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { obfuscateHireEmail } from '@hire/services/privacyService'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z
  .object({
    capability: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
  })
  .strict()

async function hasResumableV2ConsentAttempt(
  round: Pick<
    IHireRound,
    '_id' | 'workspaceId' | 'applicationId' | 'jobId' | 'candidateId' | 'consentVersion'
  >,
): Promise<boolean> {
  // Current-version attempts use the normal current consent path. Any
  // recognized historical receipt (V2–V5) may only resume its exact existing
  // attempt; it is never re-consented or upgraded to V6.
  if (!round.consentVersion || round.consentVersion === HIRE_AI_CONSENT_VERSION) {
    return false
  }
  const attempt = await HireInterviewAttempt.findOne({
    workspaceId: round.workspaceId,
    applicationId: round.applicationId,
    jobId: round.jobId,
    candidateId: round.candidateId,
    roundId: round._id,
    live: true,
  })
    .select('_id consentReceiptId')
    .lean<Pick<IHireInterviewAttempt, '_id' | 'consentReceiptId'> | null>()
  if (!attempt) return false
  const receipt = await HireConsentReceipt.findOne({
    _id: attempt.consentReceiptId,
    workspaceId: round.workspaceId,
    applicationId: round.applicationId,
    jobId: round.jobId,
    candidateId: round.candidateId,
    roundId: round._id,
    attemptId: attempt._id,
    'accepted.recording': true,
    'accepted.identityPhoto': true,
    'accepted.attentionMonitoring': true,
    'accepted.aiEvaluation': true,
  })
    .select('consentVersion disclosureDigest')
    .lean()
  return (
    receipt?.consentVersion === round.consentVersion &&
    isRecognizedHireConsentSnapshot(receipt)
  )
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(`${ip}:${roundId}`, {
    windowMs: 15 * 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-candidate-bootstrap',
  })
  if (blocked) return blocked

  try {
    const body = BodySchema.parse(await req.json())
    const verified = await verifyRoundToken(roundId, body.capability)
    if (!verified) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const { round } = verified
    if (verified.state !== 'ok') {
      return NextResponse.json(
        {
          state: verified.state,
          privacyAvailable: true,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const [job, workspace, legacyConsentAttempt] = await Promise.all([
      HireJob.findOne({
        _id: round.jobId,
        workspaceId: round.workspaceId,
      })
        .select('title')
        .lean(),
      HireWorkspace.findOne({
        _id: round.workspaceId,
        $or: [
          { lifecycleState: 'active' },
          { lifecycleState: { $exists: false } },
        ],
      })
        .select('name')
        .lean(),
      hasResumableV2ConsentAttempt(round),
    ])
    if (!job || !workspace) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    return NextResponse.json(
      {
        state: 'ok',
        privacyAvailable: true,
        workspaceName: workspace.name,
        jobTitle: job.title,
        duration: round.config.duration,
        authMode: round.authMode === 'otp' ? 'otp' : 'magic_link',
        consentAlreadyGiven: Boolean(round.consentAt),
        legacyConsentAttempt,
        emailHint: obfuscateHireEmail(round.candidateEmail),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return NextResponse.json(
      { error: 'The interview could not be loaded' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
}
