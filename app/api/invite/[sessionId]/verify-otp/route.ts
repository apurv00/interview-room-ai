/**
 * POST /api/invite/[sessionId]/verify-otp
 *
 * Verifies a candidate-supplied OTP and, on success, adopts the invited
 * interview session for the candidate and hands back a short-lived auth
 * ticket. The client then calls `signIn('invite-otp', { ticket })` to
 * receive a real NextAuth session cookie.
 *
 * Why a ticket instead of setting the session cookie directly?
 *   - NextAuth v4 has no server-side "set session for user X" helper
 *     that's part of its public contract.
 *   - A dedicated verify-otp endpoint gives us specific error reasons
 *     (expired / locked / mismatch) that a Credentials provider's
 *     `authorize()` cannot — NextAuth collapses everything to 401.
 *   - The ticket is 60-second, single-use, Redis-backed. It's a
 *     narrow, auditable handoff primitive.
 *
 * Security posture:
 *   - OTP verification (including lockout after 5 attempts) lives in
 *     otpService and is the primary defence. This route adds IP+session
 *     rate limits on top to slow automated abuse before it hits Redis.
 *   - Invite token is verified again here — defence in depth. Even if
 *     somehow the OTP is compromised, the token must still match.
 *   - Token is nulled out atomically when the session is adopted,
 *     making invite URLs single-use.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, User } from '@shared/db/models'
import { verifyInviteToken } from '@b2b/services/hireService'
import { verifyOtp } from '@b2b/services/otpService'
import { issueAuthTicket } from '@b2b/services/inviteTicketService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  token: z.string().min(1).max(512),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  email: z.string().email().max(200),
})

export async function POST(
  req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  const { sessionId } = params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  // 1. Per-IP rate limit.
  const ipBlocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:invite-verify:ip',
  })
  if (ipBlocked) return ipBlocked

  // 2. Per-sessionId rate limit (looser than request-otp — OTP service
  // already has a 5-attempt lockout; this is just burst control).
  const sessionBlocked = await checkRateLimit(sessionId, {
    windowMs: 15 * 60_000,
    maxRequests: 15,
    keyPrefix: 'rl:invite-verify:session',
  })
  if (sessionBlocked) return sessionBlocked

  // 3. Validate body.
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // 4. Verify invite token (defence in depth).
  const tokenValid = await verifyInviteToken(sessionId, body.token).catch(() => false)
  if (!tokenValid) {
    return NextResponse.json(
      { ok: false, reason: 'invalid_token' },
      { status: 400 },
    )
  }

  // 5. Verify OTP. Consumes on success; increments attempts on failure.
  const result = await verifyOtp(sessionId, body.email, body.otp)
  if (!result.ok) {
    if (result.reason === 'locked') {
      return NextResponse.json(
        { ok: false, reason: 'locked' },
        { status: 429 },
      )
    }
    if (result.reason === 'redis_error') {
      return NextResponse.json(
        { ok: false, reason: 'service_unavailable' },
        { status: 503 },
      )
    }
    return NextResponse.json(
      { ok: false, reason: 'invalid_code' },
      { status: 400 },
    )
  }

  // 6. Adopt the interview session: find-or-create the User record, then
  // bind it to the session and invalidate the invite token.
  await connectDB()

  const normalizedEmail = body.email.toLowerCase()
  const sessionDoc = await InterviewSession.findById(sessionId)
    .select('candidateEmail candidateName status organizationId')
    .lean()

  if (!sessionDoc || sessionDoc.candidateEmail?.toLowerCase() !== normalizedEmail) {
    // Extremely unlikely — verifyOtp enforces the email match too — but
    // guard anyway so a race where the session was mutated between
    // issueOtp and verifyOtp doesn't hand back a ticket for a stale state.
    authLogger.error({ sessionId }, 'verify-otp: session email mismatch post-verification')
    return NextResponse.json({ ok: false, reason: 'invalid_code' }, { status: 400 })
  }

  let candidate = await User.findOne({ email: normalizedEmail })
  if (!candidate) {
    candidate = await User.create({
      email: normalizedEmail,
      name: sessionDoc.candidateName || normalizedEmail.split('@')[0] || 'Candidate',
      emailVerified: new Date(),
      role: 'candidate',
      plan: 'free',
      monthlyInterviewLimit: 999999,
      onboardingCompleted: true,
    })
  }

  // Adopt the session atomically. Setting the userId and clearing the
  // invite-token fields in one update makes the invite URL single-use.
  await InterviewSession.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        userId: candidate._id,
      },
      $unset: {
        inviteTokenHash: 1,
        inviteTokenExpiry: 1,
      },
    },
  )

  // 7. Mint the auth ticket. Failing here is non-fatal for OTP
  // correctness (already consumed) but means the user can't sign in.
  // We surface 503 so the client tells the user to retry.
  const ticket = await issueAuthTicket(candidate._id.toString(), sessionId)
  if (!ticket) {
    return NextResponse.json(
      { ok: false, reason: 'service_unavailable' },
      { status: 503 },
    )
  }

  return NextResponse.json({ ok: true, ticket })
}
