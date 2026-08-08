/**
 * POST /api/candidate/[roundId]/begin — the guest's entry into the interview.
 *
 * Behavior follows the round's snapshotted authMode — the COMPANY's choice
 * of verification (workspace setting, fixed per link at send time):
 *
 *   magic_link → the emailed link is the authentication. Records consent,
 *     mints the round's synthetic guest User, binds it, returns the 60s
 *     single-use ticket for `signIn('invite-otp', { ticket })`.
 *
 *   otp → additionally proves CURRENT mailbox control before any identity
 *     exists: records consent, emails a 6-digit code to the candidate's
 *     address on record (never a caller-supplied address), and returns
 *     { otpRequired: true }. The ticket is only minted by /verify.
 *
 * Common to both modes: consent is recorded FIRST and no ticket can ever
 * exist without the record; the guest identity is always the per-round
 * synthetic User (`round-<id>@guests.interviewprep.internal`) — the
 * candidate's real email never enters the B2C users table. Gates: token
 * validity + expiry/grace, revocation, dual IP+round rate limits.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  verifyRoundToken,
  recordConsent,
  bindGuestUser,
  GuestBeginSchema,
  HIRE_CONSENT_VERSION,
} from '@hire'
import { ensureGuestUser } from '../../_lib/guestUser'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
import { issueOtp } from '@b2b/services/otpService'
import { sendEmail } from '@shared/services/emailService'
import { buildInviteOtpEmail } from '@shared/services/emailTemplates/inviteOtp'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { AppError } from '@shared/errors'
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
    maxRequests: 20,
    keyPrefix: 'rl:hire-begin:ip',
  })
  if (ipBlocked) return ipBlocked

  const roundBlocked = await checkRateLimit(roundId, {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-begin:round',
  })
  if (roundBlocked) return roundBlocked

  let token: string
  try {
    token = GuestBeginSchema.parse(await req.json()).token
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const verified = await verifyRoundToken(roundId, token)
    if (!verified || verified.state !== 'ok') {
      return NextResponse.json(
        { error: 'This interview link is no longer valid', code: 'ROUND_LINK_INVALID' },
        { status: 410 }
      )
    }
    const { round } = verified

    // Consent first — in either mode, nothing downstream exists without it.
    await recordConsent(roundId, token, {
      userAgent: req.headers.get('user-agent') ?? undefined,
    })

    if (round.authMode === 'otp') {
      // Mailbox-control challenge: the code goes to the address on record —
      // the caller never supplies an email. Re-calling begin rotates the
      // code (resend) but never resets the 5-attempt lockout (otpService).
      const issued = await issueOtp(`hire:${roundId}`, round.candidateEmail)
      if (!issued) {
        return NextResponse.json(
          { error: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' },
          { status: 503 }
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
      })
      if (!sent.ok) {
        authLogger.warn({ roundId }, 'hire begin: OTP email send failed')
        return NextResponse.json(
          { error: 'We could not send the code. Please try again.', code: 'OTP_SEND_FAILED' },
          { status: 503 }
        )
      }
      return NextResponse.json({ ok: true, otpRequired: true })
    }

    // magic_link: the link is the credential — mint identity + ticket now.
    const guest = await ensureGuestUser(roundId, round.candidateName)
    await bindGuestUser(roundId, token, guest._id.toString())
    const ticket = await issueAuthTicket(guest._id.toString(), roundId)
    if (!ticket) {
      return NextResponse.json(
        { error: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 }
      )
    }
    return NextResponse.json({ ok: true, ticket, consentVersion: HIRE_CONSENT_VERSION })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    authLogger.error({ err, roundId }, 'hire begin: failed')
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
