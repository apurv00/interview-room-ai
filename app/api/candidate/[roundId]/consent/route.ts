/**
 * POST /api/candidate/[roundId]/consent
 *
 * Records the candidate's acceptance of the recording + AI-analysis
 * disclosure for one AI interview round. Consent gates everything downstream:
 * OTP issuance and verification both refuse to run until consentAt is set on
 * the round, so the disclosure cannot be skipped by calling the API directly.
 * Token-gated (the emailed invite token), unauthenticated, idempotent.
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordConsent, GuestConsentSchema, HIRE_CONSENT_VERSION } from '@hire'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: { roundId: string } }
) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const ipBlocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-consent:ip',
  })
  if (ipBlocked) return ipBlocked

  let token: string
  try {
    token = GuestConsentSchema.parse(await req.json()).token
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    await recordConsent(params.roundId, token, {
      userAgent: req.headers.get('user-agent') ?? undefined,
    })
    return NextResponse.json({ ok: true, consentVersion: HIRE_CONSENT_VERSION })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
