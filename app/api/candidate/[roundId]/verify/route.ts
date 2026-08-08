/**
 * POST /api/candidate/[roundId]/verify — otp mode's second step.
 *
 * Checks the 6-digit code (emailed by /begin to the address on record;
 * otpService owns the 5-attempt lockout), then completes the guest-auth
 * seam exactly as magic_link's /begin does: synthetic per-round User →
 * bind → 60s single-use ticket. Refuses magic_link rounds — there is no
 * code to verify, and accepting one would let a caller skip nothing anyway
 * (both paths require the same token + recorded consent).
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyRoundToken, bindGuestUser, GuestVerifyCodeSchema } from '@hire'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
import { verifyOtp } from '@b2b/services/otpService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { AppError } from '@shared/errors'
import { authLogger } from '@shared/logger'
import { ensureGuestUser } from '../../_lib/guestUser'

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

  let body: { token: string; code: string }
  try {
    body = GuestVerifyCodeSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const verified = await verifyRoundToken(roundId, body.token)
    if (
      !verified ||
      verified.state !== 'ok' ||
      verified.round.authMode !== 'otp' ||
      !verified.round.consentAt
    ) {
      return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
    }
    const { round } = verified

    const result = await verifyOtp(`hire:${roundId}`, round.candidateEmail, body.code)
    if (!result.ok) {
      if (result.reason === 'locked') {
        return NextResponse.json({ ok: false, reason: 'locked' }, { status: 429 })
      }
      if (result.reason === 'redis_error') {
        return NextResponse.json({ ok: false, reason: 'service_unavailable' }, { status: 503 })
      }
      return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
    }

    const guest = await ensureGuestUser(roundId, round.candidateName)
    await bindGuestUser(roundId, body.token, guest._id.toString())
    const ticket = await issueAuthTicket(guest._id.toString(), roundId)
    if (!ticket) {
      return NextResponse.json({ ok: false, reason: 'service_unavailable' }, { status: 503 })
    }
    return NextResponse.json({ ok: true, ticket })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    authLogger.error({ err, roundId }, 'hire verify: failed')
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
