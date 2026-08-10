import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { verifyRoundToken } from '@hire'
import { GuestBeginSchema, type GuestBeginPayload } from '@hire/validators/hire'
import {
  acceptHireConsentAndIssueGuestSession,
  HireGuestAccessError,
} from '@hire/services/identityConsentService'
import {
  assertCompleteHireConsent,
  HireConsentError,
} from '@hire/policies/aiInterviewConsent'
import { issueOtp } from '@b2b/services/otpService'
import { sendEmail } from '@shared/services/emailService'
import { buildInviteOtpEmail } from '@shared/services/emailTemplates/inviteOtp'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'
import { setHireGuestCookie } from '../../_lib/hireGuestHttp'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function requestIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function consentError(error: unknown): NextResponse | null {
  if (error instanceof HireConsentError || error instanceof HireGuestAccessError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    )
  }
  return null
}

/**
 * Starts a Hire-owned candidate session. The real candidate email is used only
 * as the destination of the optional mailbox-control OTP; it is never resolved
 * against, linked to, or written into a B2C User.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } },
) {
  const { roundId } = params
  const [ipBlocked, roundBlocked] = await Promise.all([
    checkRateLimit(requestIp(req), {
      windowMs: 15 * 60_000,
      maxRequests: 20,
      keyPrefix: 'rl:hire-begin:ip',
    }),
    checkRateLimit(roundId, {
      windowMs: 15 * 60_000,
      maxRequests: 10,
      keyPrefix: 'rl:hire-begin:round',
    }),
  ])
  if (ipBlocked) return ipBlocked
  if (roundBlocked) return roundBlocked

  let body: GuestBeginPayload
  try {
    body = GuestBeginSchema.parse(await req.json())
    assertCompleteHireConsent(body.accepted)
  } catch (error) {
    if (error instanceof HireConsentError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const verified = await verifyRoundToken(roundId, body.capability)
    if (!verified || verified.state !== 'ok') {
      return NextResponse.json(
        { error: 'This interview link is no longer valid', code: 'ROUND_LINK_INVALID' },
        { status: 410 },
      )
    }
    const { round } = verified

    if (round.authMode === 'otp') {
      const issueBlocked = await checkRateLimit(roundId, {
        windowMs: 15 * 60_000,
        maxRequests: 3,
        keyPrefix: 'rl:hire-otp-issue',
      })
      if (issueBlocked) return issueBlocked

      const otpScope = `hire:${round.workspaceId.toString()}:${roundId}`
      const issued = await issueOtp(otpScope, round.candidateEmail)
      if (!issued) {
        return NextResponse.json(
          { error: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' },
          { status: 503 },
        )
      }
      const email = buildInviteOtpEmail({
        code: issued.code,
        candidateName: round.candidateName,
        expiryMinutes: 10,
      })
      const sent = await sendEmail({
        to: round.candidateEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: createHash('sha256')
          .update(`hire-otp:${roundId}:${issued.code}`)
          .digest('hex'),
      })
      if (!sent.ok) {
        authLogger.warn({ roundId }, 'hire begin: OTP email send failed')
        return NextResponse.json(
          { error: 'We could not send the code. Please try again.', code: 'OTP_SEND_FAILED' },
          { status: 503 },
        )
      }
      return NextResponse.json(
        { ok: true, otpRequired: true },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const accepted = await acceptHireConsentAndIssueGuestSession({
      roundId,
      inviteCapability: body.capability,
      accepted: body.accepted,
      userAgent: req.headers.get('user-agent') ?? undefined,
      locale: req.headers.get('accept-language')?.split(',')[0]?.trim(),
    })
    const response = NextResponse.json(
      {
        ok: true,
        next: 'identity_photo',
        csrfToken: accepted.csrfToken,
        consentVersion: accepted.consentVersion,
        disclosureDigest: accepted.disclosureDigest,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
    setHireGuestCookie(response, accepted.credential, accepted.scope.expiresAt)
    return response
  } catch (error) {
    const expected = consentError(error)
    if (expected) return expected
    authLogger.error({ error, roundId }, 'hire begin: failed')
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
