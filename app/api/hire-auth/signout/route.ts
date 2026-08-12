import { NextRequest, NextResponse } from 'next/server'
import {
  HIRE_MEMBER_COOKIE,
  revokeHireMemberSession,
} from '@hire/services/memberAuthService'
import { clearHireMemberCookie } from '../_lib/cookie'
import { hasTrustedOrigin } from '../_lib/request'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  await revokeHireMemberSession(req.cookies.get(HIRE_MEMBER_COOKIE)?.value)
  const response = NextResponse.json({ ok: true })
  clearHireMemberCookie(response)
  return response
}
