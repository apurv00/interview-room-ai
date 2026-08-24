import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { verifyOtp } from '@shared/auth/mailboxOtp'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import {
  HirePrivacyError,
  applyVerifiedHirePrivacyRequest,
  getHirePrivacyVerificationTarget,
} from '@hire/services/privacyService'

export const dynamic = 'force-dynamic'

const BodySchema = z
  .object({
    requestCapability: z
      .string()
      .regex(/^[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{64}$/i),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  try {
    const body = BodySchema.parse(await req.json())
    const capabilityDigest = createHash('sha256')
      .update(body.requestCapability.toLowerCase())
      .digest('hex')
    const blocked = await checkRateLimit(`${ip}:${capabilityDigest}`, {
      windowMs: 15 * 60_000,
      maxRequests: 10,
      keyPrefix: 'rl:hire-privacy-verify',
    })
    if (blocked) return blocked

    const target = await getHirePrivacyVerificationTarget({
      requestCapability: body.requestCapability,
    })
    const verified = await verifyOtp(
      `hire-privacy:${target.request.workspaceId.toString()}:${target.request._id.toString()}`,
      target.email,
      body.code,
    )
    if (!verified.ok) {
      return NextResponse.json(
        { error: 'The code is invalid or expired', code: 'OTP_INVALID' },
        {
          status:
            verified.reason === 'locked'
              ? 429
              : verified.reason === 'redis_error'
                ? 503
                : 400,
        },
      )
    }
    await applyVerifiedHirePrivacyRequest({
      requestCapability: body.requestCapability,
    })
    return NextResponse.json(
      { accepted: true, status: 'processing' },
      { status: 202, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    if (error instanceof HirePrivacyError) {
      return NextResponse.json(
        { error: 'Privacy verification failed', code: error.code },
        { status: error.status },
      )
    }
    return NextResponse.json({ error: 'Privacy verification failed' }, { status: 500 })
  }
}
