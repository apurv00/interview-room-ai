import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateHireMember } from '@hire/services/memberAuthService'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { setHireMemberCookie } from '../_lib/cookie'
import { clientIp, hasTrustedOrigin } from '../_lib/request'

const SignInSchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{24}$/i),
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
})

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  const blocked = await checkRateLimit(clientIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-member-signin',
  })
  if (blocked) return blocked
  try {
    const body = SignInSchema.parse(await req.json())
    const auth = await authenticateHireMember(body.workspaceId, body.email, body.password)
    const response = NextResponse.json({ ok: true })
    setHireMemberCookie(response, auth.sessionCredential, auth.expiresAt)
    return response
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid sign-in details' }, { status: 400 })
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      )
    }
    return NextResponse.json({ error: 'Could not sign in' }, { status: 500 })
  }
}
