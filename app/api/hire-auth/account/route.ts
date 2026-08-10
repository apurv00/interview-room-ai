import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { AppError } from '@shared/errors'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import {
  HIRE_MEMBER_COOKIE,
  resolveHireMemberSession,
} from '@hire/services/memberAuthService'
import { selfDeleteHireMember } from '@hire/services/memberLifecycleService'
import {
  SelfDeleteHireMemberSchema,
  type SelfDeleteHireMemberPayload,
} from '@hire/validators/hire'
import { clearHireMemberCookie } from '../_lib/cookie'
import { clientIp, hasTrustedOrigin } from '../_lib/request'

export const dynamic = 'force-dynamic'

/** DELETE — remove the authenticated Hire-owned member account only. */
export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV === 'production' && process.env.IPG_SURFACE !== 'hire-control') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  const blocked = await checkRateLimit(clientIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:hire-member-self-delete',
  })
  if (blocked) return blocked

  const rawToken = req.cookies.get(HIRE_MEMBER_COOKIE)?.value
  const auth = await resolveHireMemberSession(rawToken)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body: SelfDeleteHireMemberPayload = SelfDeleteHireMemberSchema.parse(await req.json())
    const result = await selfDeleteHireMember(auth, body)
    const response = NextResponse.json({
      ok: true,
      workspaceDeletionScheduled: result.workspaceDeletionScheduled,
      ...(result.purgeAfter ? { purgeAfter: result.purgeAfter.toISOString() } : {}),
    })
    clearHireMemberCookie(response)
    return response
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
    }
    if (error instanceof AppError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.statusCode },
      )
    }
    return NextResponse.json({ error: 'Could not delete your Hire account' }, { status: 500 })
  }
}
