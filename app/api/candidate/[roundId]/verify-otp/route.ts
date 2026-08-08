/**
 * POST /api/candidate/[roundId]/verify-otp
 *
 * Verifies the candidate's OTP for a hire AI-interview round and hands back
 * a 60-second single-use auth ticket for `signIn('invite-otp', { ticket })`.
 *
 * This route IS the guest-session auth seam (goal item 2): the one sanctioned
 * place the hire flow writes a B2C row — find-or-create the guest User —
 * mirroring the v1 invite flow verbatim (app/api/invite/[sessionId]/
 * verify-otp). Unlike v1 it adopts nothing on the engine side: the round
 * binding (guestUserId) lives on the hire-owned HireRound row.
 *
 * Requires recorded consent — the disclosure gate holds even for direct API
 * callers. OTP lockout (5 attempts) lives in otpService; the rate limits here
 * are burst control on top.
 */

import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { verifyRoundToken, bindGuestUser, GuestVerifyOtpSchema } from '@hire'
import { verifyOtp } from '@b2b/services/otpService'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

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
    maxRequests: 30,
    keyPrefix: 'rl:hire-verify:ip',
  })
  if (ipBlocked) return ipBlocked

  const roundBlocked = await checkRateLimit(roundId, {
    windowMs: 15 * 60_000,
    maxRequests: 15,
    keyPrefix: 'rl:hire-verify:round',
  })
  if (roundBlocked) return roundBlocked

  let body: { token: string; email: string; code: string }
  try {
    body = GuestVerifyOtpSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // Token + consent + email binding — defence in depth ahead of the OTP check.
  const verified = await verifyRoundToken(roundId, body.token).catch(() => null)
  const normalizedEmail = body.email.toLowerCase()
  if (
    !verified ||
    verified.state !== 'ok' ||
    !verified.round.consentAt ||
    verified.round.candidateEmail !== normalizedEmail
  ) {
    return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
  }

  const result = await verifyOtp(`hire:${roundId}`, normalizedEmail, body.code)
  if (!result.ok) {
    if (result.reason === 'locked') {
      return NextResponse.json({ ok: false, reason: 'locked' }, { status: 429 })
    }
    if (result.reason === 'redis_error') {
      return NextResponse.json({ ok: false, reason: 'service_unavailable' }, { status: 503 })
    }
    return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
  }

  // Guest-session auth seam: find-or-create the B2C User (v1 parity —
  // including the uncapped interview limit so the guest's interview never
  // trips the B2C monthly quota).
  await connectDB()
  let guest = await User.findOne({ email: normalizedEmail })
  if (!guest) {
    guest = await User.create({
      email: normalizedEmail,
      name:
        verified.round.candidateName || normalizedEmail.split('@')[0] || 'Candidate',
      emailVerified: new Date(),
      role: 'candidate',
      plan: 'free',
      monthlyInterviewLimit: 999999,
    })
  }

  try {
    await bindGuestUser(roundId, body.token, guest._id.toString())
  } catch (err) {
    authLogger.error({ err, roundId }, 'hire verify-otp: failed to bind guest user to round')
    return NextResponse.json({ ok: false, reason: 'service_unavailable' }, { status: 503 })
  }

  const ticket = await issueAuthTicket(guest._id.toString(), roundId)
  if (!ticket) {
    return NextResponse.json({ ok: false, reason: 'service_unavailable' }, { status: 503 })
  }

  return NextResponse.json({ ok: true, ticket })
}
