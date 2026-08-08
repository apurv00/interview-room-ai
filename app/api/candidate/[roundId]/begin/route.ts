/**
 * POST /api/candidate/[roundId]/begin — magic-link entry into the interview.
 *
 * The emailed invite link IS the authentication (founder decision on #603:
 * possession of the link, delivered to the candidate's mailbox, is the
 * identity proof — the previous OTP step and its whole failure surface are
 * gone). One call does the full guest-auth seam:
 *
 *   1. verify the round token (sha256-at-rest, expiring, revocable),
 *   2. record consent — the client shows the recording + AI-analysis
 *      disclosure and calls this only after explicit agreement; consentAt/
 *      version/user-agent are recorded first-wins, and no ticket can exist
 *      without that record,
 *   3. find-or-create the round's SYNTHETIC guest User (per-round identity:
 *      `round-<id>@guests.interviewprep.internal`, non-routable, never
 *      sign-in-able outside the 60s ticket) — the one sanctioned B2C write,
 *   4. bind it to the round and mint the single-use auth ticket for
 *      `signIn('invite-otp', { ticket })`.
 *
 * Remaining gates: token validity + expiry/grace, revocation, consent,
 * dual IP+round rate limits. No real-candidate email ever enters the B2C
 * users table.
 */

import { NextRequest, NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import {
  verifyRoundToken,
  recordConsent,
  bindGuestUser,
  guestEmailForRound,
  GuestConsentSchema,
  HIRE_CONSENT_VERSION,
} from '@hire'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
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
    token = GuestConsentSchema.parse(await req.json()).token
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

    // Consent first — the ticket below cannot exist without this record.
    await recordConsent(roundId, token, {
      userAgent: req.headers.get('user-agent') ?? undefined,
    })

    // Per-round synthetic guest User (idempotent on the unique email).
    await connectDB()
    const syntheticEmail = guestEmailForRound(roundId)
    let guest = await User.findOne({ email: syntheticEmail })
    if (!guest) {
      try {
        guest = await User.create({
          email: syntheticEmail,
          name: verified.round.candidateName || 'Candidate',
          emailVerified: new Date(),
          role: 'candidate',
          plan: 'free',
          monthlyInterviewLimit: 999999,
        })
      } catch (err: unknown) {
        // Concurrent begin (double-click / second tab) raced the create —
        // the unique email index collapses it; reuse the winner's row.
        if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
          guest = await User.findOne({ email: syntheticEmail })
        }
        if (!guest) throw err
      }
    }

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
