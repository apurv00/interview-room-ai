import { NextRequest, NextResponse } from 'next/server'
import {
  applyHireMemberRequestCookies,
  resolveHireMemberRequestSession,
} from '../_lib/memberSession'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const memberSession = await resolveHireMemberRequestSession(req)
  const auth = memberSession.auth
  if (!auth) {
    return applyHireMemberRequestCookies(
      NextResponse.json(
        { authenticated: false },
        { headers: { 'Cache-Control': 'private, no-store' } },
      ),
      memberSession,
    )
  }
  return applyHireMemberRequestCookies(
    NextResponse.json(
      {
        authenticated: true,
        workspace: {
          id: auth.workspace._id.toString(),
          slug: auth.workspace.signInSlug ?? null,
          name: auth.workspace.name,
        },
        member: {
          id: auth.membership._id.toString(),
          name: auth.membership.name,
          email: auth.membership.email,
          role: auth.membership.role,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    ),
    memberSession,
  )
}
