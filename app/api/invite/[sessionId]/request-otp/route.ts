/**
 * POST /api/invite/[sessionId]/request-otp
 *
 * Issues a 6-digit OTP to the email address on a valid invite and sends
 * it via the existing Resend integration.
 *
 * Security posture:
 *   - Unauthenticated endpoint — gate is the invite token + candidate email match.
 *   - Rate limited twice: per-IP (10/15m) and per-sessionId (3/15m) so a
 *     single compromised IP can't drain OTPs across many invites, and a
 *     single invite can't be pounded from many IPs.
 *   - Response shape is constant regardless of whether the email matched —
 *     prevents enumerating which emails are invited to which sessions.
 *   - No email address is ever logged (pino logger redacts, but the
 *     `email` field is also never passed into log objects here).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, Organization } from '@shared/db/models'
import { verifyInviteToken } from '@b2b/services/hireService'
import { issueOtp } from '@b2b/services/otpService'
import { buildInviteOtpEmail } from '@shared/services/emailTemplates/inviteOtp'
import { sendEmail } from '@shared/services/emailService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { authLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  token: z.string().min(1).max(512),
  email: z.string().email().max(200),
})

const OTP_EXPIRY_MINUTES = 10

// Constant-shape response — never signals whether the email matched.
const GENERIC_OK = NextResponse.json({ ok: true })

export async function POST(
  req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  const { sessionId } = params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  // 1. Per-IP rate limit: protects against someone sweeping many invites.
  const ipBlocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:invite-otp:ip',
  })
  if (ipBlocked) return ipBlocked

  // 2. Per-sessionId rate limit: protects against flooding a single invite.
  const sessionBlocked = await checkRateLimit(sessionId, {
    windowMs: 15 * 60_000,
    maxRequests: 3,
    keyPrefix: 'rl:invite-otp:session',
  })
  if (sessionBlocked) return sessionBlocked

  // 3. Validate body shape.
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // 4. Verify token against stored hash + expiry.
  const tokenValid = await verifyInviteToken(sessionId, body.token).catch(() => false)
  if (!tokenValid) {
    authLogger.warn({ sessionId }, 'request-otp: invalid or expired invite token')
    return GENERIC_OK
  }

  // 5. Lookup session to confirm the email matches the invited candidate.
  await connectDB()
  const session = await InterviewSession.findById(sessionId)
    .select('candidateEmail candidateName organizationId status')
    .lean()

  if (!session) return GENERIC_OK
  if (!session.candidateEmail) return GENERIC_OK
  if (session.status !== 'created') {
    // Already in-progress, completed, or abandoned — token should never
    // reach this endpoint for those statuses (createInvite only sets
    // status='created'), but guard anyway.
    return GENERIC_OK
  }
  if (session.candidateEmail.toLowerCase() !== body.email.toLowerCase()) {
    // Email didn't match. Respond the same way we do for success so
    // attackers can't enumerate valid invited addresses.
    authLogger.warn({ sessionId }, 'request-otp: email mismatch on valid token')
    return GENERIC_OK
  }

  // 6. Issue OTP (Redis). If Redis is down, 503 — don't silently skip auth.
  const issued = await issueOtp(sessionId, body.email)
  if (!issued) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable — please retry.' },
      { status: 503 },
    )
  }

  // 7. Fetch org name for branding (optional). Kept small — only need the name.
  let orgName: string | undefined
  if (session.organizationId) {
    const org = await Organization.findById(session.organizationId).select('name').lean()
    orgName = org?.name
  }

  // 8. Send OTP email. Fire-and-forget — do NOT reveal send failures to the
  // client (stays constant-shape). The OTP still lives in Redis so ops can
  // resend if there's a transient Resend outage.
  const { subject, html } = buildInviteOtpEmail({
    code: issued.code,
    candidateName: session.candidateName ?? undefined,
    orgName,
    expiryMinutes: OTP_EXPIRY_MINUTES,
  })
  await sendEmail({ to: body.email.toLowerCase(), subject, html }).catch(() => false)

  return GENERIC_OK
}
