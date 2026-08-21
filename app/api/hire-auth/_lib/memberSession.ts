import type { NextRequest, NextResponse } from 'next/server'
import {
  resolveHireMemberSession,
  revokeHireMemberSession,
  type AuthenticatedHireMember,
} from '@hire/services/memberAuthService'
import {
  clearHireMemberCookie,
  clearLegacyHireMemberCookie,
  readHireMemberCookies,
} from './cookie'

type ResolvedHireMember = Pick<
  AuthenticatedHireMember,
  'workspace' | 'membership'
>

export interface HireMemberRequestSession {
  auth: ResolvedHireMember | null
  sessionCredential?: string
  clearLegacyCookie: boolean
  clearCurrentCookie: boolean
}

/**
 * Resolves only the host-only credential. A legacy Domain cookie is never an
 * authentication source: a sibling origin could have planted it to cause
 * login CSRF/account confusion. Legacy credentials are revoked and expired;
 * legacy-only clients must establish a fresh session through password sign-in.
 */
export async function resolveHireMemberRequestSession(
  req: NextRequest,
): Promise<HireMemberRequestSession> {
  const cookies = readHireMemberCookies(req)

  if (cookies.current) {
    if (cookies.legacy === cookies.current) {
      await revokeHireMemberSession(cookies.current)
      return {
        auth: null,
        clearLegacyCookie: true,
        clearCurrentCookie: true,
      }
    }

    const auth = await resolveHireMemberSession(cookies.current)
    if (cookies.legacy) {
      await revokeHireMemberSession(cookies.legacy)
    }
    return {
      auth,
      ...(auth ? { sessionCredential: cookies.current } : {}),
      clearLegacyCookie: Boolean(cookies.legacy),
      clearCurrentCookie: !auth,
    }
  }

  if (cookies.legacy) {
    await revokeHireMemberSession(cookies.legacy)
    return {
      auth: null,
      clearLegacyCookie: true,
      clearCurrentCookie: false,
    }
  }

  return {
    auth: null,
    clearLegacyCookie: false,
    clearCurrentCookie: false,
  }
}

export function applyHireMemberRequestCookies(
  response: NextResponse,
  session: HireMemberRequestSession,
): NextResponse {
  if (session.clearCurrentCookie) {
    clearHireMemberCookie(response)
  } else if (session.clearLegacyCookie) {
    clearLegacyHireMemberCookie(response)
  }
  return response
}

export async function revokeRequestHireMemberSessions(
  req: NextRequest,
): Promise<void> {
  const cookies = readHireMemberCookies(req)
  if (cookies.current) await revokeHireMemberSession(cookies.current)
  if (cookies.legacy && cookies.legacy !== cookies.current) {
    await revokeHireMemberSession(cookies.legacy)
  }
}

export async function revokeLegacyRequestHireMemberSession(
  req: NextRequest,
): Promise<void> {
  const legacy = readHireMemberCookies(req).legacy
  if (legacy) await revokeHireMemberSession(legacy)
}
