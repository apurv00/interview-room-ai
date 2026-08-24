import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { issueOtp } from '@shared/auth/mailboxOtp'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { sendEmail } from '@shared/services/emailService'
import { buildHirePrivacyDeletionOtpEmail } from '@hire/emails/privacyDeletionOtpEmail'
import {
  HirePrivacyError,
  PRIVACY_VERIFICATION_TTL_MS,
  createHirePrivacyRequestFromInvite,
} from '@hire/services/privacyService'

export const dynamic = 'force-dynamic'

const BodySchema = z
  .object({
    capability: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
  })
  .strict()

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } },
) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(`${ip}:${params.roundId}`, {
    windowMs: 15 * 60_000,
    maxRequests: 3,
    keyPrefix: 'rl:hire-privacy-request',
  })
  if (blocked) return blocked
  try {
    const body = BodySchema.parse(await req.json())
    const target = await createHirePrivacyRequestFromInvite({
      roundId: params.roundId,
      inviteCapability: body.capability,
    })
    const issued = await issueOtp(
      `hire-privacy:${target.request.workspaceId.toString()}:${target.request._id.toString()}`,
      target.email,
    )
    if (!issued) {
      return NextResponse.json(
        { error: 'Verification is temporarily unavailable', code: 'OTP_UNAVAILABLE' },
        { status: 503 },
      )
    }
    const email = buildHirePrivacyDeletionOtpEmail({
      code: issued.code,
      expiryMinutes: Math.floor(PRIVACY_VERIFICATION_TTL_MS / 60_000),
    })
    const sent = await sendEmail({
      to: target.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: createHash('sha256')
        .update(
          `hire-privacy:${target.request.workspaceId.toString()}:${target.request._id.toString()}:${target.request.verificationExpiresAt.getTime()}`,
        )
        .digest('hex'),
    })
    if (!sent.ok) {
      return NextResponse.json(
        { error: 'Verification email could not be sent', code: 'OTP_SEND_FAILED' },
        { status: 503 },
      )
    }
    return NextResponse.json(
      {
        requestCapability: target.requestCapability,
        emailHint: target.emailHint,
      },
      { status: 202, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    if (error instanceof HirePrivacyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    return NextResponse.json({ error: 'Privacy request failed' }, { status: 500 })
  }
}
