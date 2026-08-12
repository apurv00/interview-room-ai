import { NextRequest, NextResponse } from 'next/server'
import { verifyRoundToken } from '@hire'
import {
  GuestVerifyCodeSchema,
  type GuestVerifyCodePayload,
} from '@hire/validators/hire'
import {
  acceptHireConsentAndIssueGuestSession,
  HireGuestAccessError,
} from '@hire/services/identityConsentService'
import {
  assertCompleteHireConsent,
  HireConsentError,
} from '@hire/policies/aiInterviewConsent'
import { verifyOtp } from '@b2b/services/otpService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'
import { setHireGuestCookie } from '../../_lib/hireGuestHttp'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } },
) {
  const { roundId } = params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const [ipBlocked, roundBlocked] = await Promise.all([
    checkRateLimit(ip, {
      windowMs: 15 * 60_000,
      maxRequests: 30,
      keyPrefix: 'rl:hire-verify:ip',
    }),
    checkRateLimit(roundId, {
      windowMs: 15 * 60_000,
      maxRequests: 15,
      keyPrefix: 'rl:hire-verify:round',
    }),
  ])
  if (ipBlocked) return ipBlocked
  if (roundBlocked) return roundBlocked

  let body: GuestVerifyCodePayload
  try {
    body = GuestVerifyCodeSchema.parse(await req.json())
    assertCompleteHireConsent(body.accepted)
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const verified = await verifyRoundToken(roundId, body.capability)
    if (!verified || verified.state !== 'ok' || verified.round.authMode !== 'otp') {
      return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
    }
    const { round } = verified
    const result = await verifyOtp(
      `hire:${round.workspaceId.toString()}:${roundId}`,
      round.candidateEmail,
      body.code,
    )
    if (!result.ok) {
      if (result.reason === 'locked') {
        return NextResponse.json({ ok: false, reason: 'locked' }, { status: 429 })
      }
      if (result.reason === 'redis_error') {
        return NextResponse.json(
          { ok: false, reason: 'service_unavailable' },
          { status: 503 },
        )
      }
      return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
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
        next: accepted.next,
        csrfToken: accepted.csrfToken,
        consentVersion: accepted.consentVersion,
        disclosureDigest: accepted.disclosureDigest,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
    setHireGuestCookie(response, accepted.credential, accepted.scope.expiresAt)
    return response
  } catch (error) {
    if (error instanceof HireConsentError || error instanceof HireGuestAccessError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    authLogger.error({ error, roundId }, 'hire verify: failed')
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
