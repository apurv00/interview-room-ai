import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { completeMemberSetup } from '@hire/services/memberAuthService'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { setHireMemberCookie } from '../_lib/cookie'
import { revokeLegacyRequestHireMemberSession } from '../_lib/memberSession'
import { clientIp, hasTrustedOrigin } from '../_lib/request'

const SetupSchema = z
  .object({
    credential: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
    password: z
      .string()
      .min(12)
      .max(128)
      .regex(/[a-z]/, 'Include a lowercase letter')
      .regex(/[A-Z]/, 'Include an uppercase letter')
      .regex(/[0-9]/, 'Include a number'),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  const blocked = await checkRateLimit(clientIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-member-setup',
  })
  if (blocked) return blocked
  try {
    const body = SetupSchema.parse(await req.json())
    const auth = await completeMemberSetup(body.credential, body.password)
    await revokeLegacyRequestHireMemberSession(req)
    const response = NextResponse.json({
      ok: true,
      workspace: {
        id: auth.workspace._id.toString(),
        slug: auth.workspace.signInSlug ?? null,
        name: auth.workspace.name,
      },
      member: {
        id: auth.membership._id.toString(),
        name: auth.membership.name,
        email: auth.membership.email,
      },
    })
    setHireMemberCookie(response, auth.sessionCredential, auth.expiresAt)
    return response
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: err.issues },
        { status: 400 }
      )
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      )
    }
    return NextResponse.json({ error: 'Could not set up your account' }, { status: 500 })
  }
}
