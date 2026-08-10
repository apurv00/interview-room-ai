import { NextRequest, NextResponse } from 'next/server'
import {
  HIRE_MEMBER_COOKIE,
  resolveHireMemberSession,
} from '@hire/services/memberAuthService'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await resolveHireMemberSession(
    req.cookies.get(HIRE_MEMBER_COOKIE)?.value
  )
  if (!auth) {
    return NextResponse.json(
      { authenticated: false },
      { headers: { 'Cache-Control': 'private, no-store' } }
    )
  }
  return NextResponse.json(
    {
      authenticated: true,
      workspace: { id: auth.workspace._id.toString(), name: auth.workspace.name },
      member: {
        id: auth.membership._id.toString(),
        name: auth.membership.name,
        email: auth.membership.email,
        role: auth.membership.role,
      },
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}
