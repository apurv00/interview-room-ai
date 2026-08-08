/**
 * POST /api/candidate/[roundId]/request-otp
 *
 * Sends a 6-digit OTP to the candidate for a hire AI-interview round.
 * Mirrors the v1 invite request-otp security posture: dual IP + per-round
 * rate limits, and a constant-shape GENERIC_OK response for every outcome so
 * the endpoint can't be used to enumerate emails or link states. Requires
 * recorded consent on the round — the disclosure gate cannot be bypassed.
 *
 * The OTP is keyed by `hire:{roundId}` — a namespace distinct from the v1
 * invite keys (which use InterviewSession ids) sharing the same otpService.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyRoundToken, GuestRequestOtpSchema } from '@hire'
import { issueOtp } from '@b2b/services/otpService'
import { sendEmail } from '@shared/services/emailService'
import { buildInviteOtpEmail } from '@shared/services/emailTemplates/inviteOtp'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const GENERIC_OK = { ok: true, message: 'If the details match, a code is on its way.' }

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } }
) {
  const { roundId } = params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  const ipBlocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-otp:ip',
  })
  if (ipBlocked) return ipBlocked

  const roundBlocked = await checkRateLimit(roundId, {
    windowMs: 15 * 60_000,
    maxRequests: 3,
    keyPrefix: 'rl:hire-otp:round',
  })
  if (roundBlocked) return roundBlocked

  let body: { token: string; email: string }
  try {
    body = GuestRequestOtpSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const verified = await verifyRoundToken(roundId, body.token).catch(() => null)
  if (!verified || verified.state !== 'ok' || !verified.round.consentAt) {
    // Constant shape — do not reveal whether the round exists, the token
    // matches, or consent state.
    return NextResponse.json(GENERIC_OK)
  }

  const normalizedEmail = body.email.toLowerCase()
  if (verified.round.candidateEmail !== normalizedEmail) {
    return NextResponse.json(GENERIC_OK)
  }

  const issued = await issueOtp(`hire:${roundId}`, normalizedEmail)
  if (!issued) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  const email = buildInviteOtpEmail({
    code: issued.code,
    candidateName: verified.round.candidateName,
    expiryMinutes: 10,
  })
  const sent = await sendEmail({ to: normalizedEmail, subject: email.subject, html: email.html })
  if (!sent.ok) {
    authLogger.warn({ roundId }, 'hire request-otp: OTP email send failed')
  }

  return NextResponse.json(GENERIC_OK)
}
