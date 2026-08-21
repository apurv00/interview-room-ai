import { NextRequest, NextResponse } from 'next/server'
import { clearHireMemberCookie } from '../_lib/cookie'
import { revokeRequestHireMemberSessions } from '../_lib/memberSession'
import { hasTrustedOrigin } from '../_lib/request'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!hasTrustedOrigin(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }
  await revokeRequestHireMemberSessions(req)
  const response = NextResponse.json({ ok: true })
  clearHireMemberCookie(response)
  return response
}
