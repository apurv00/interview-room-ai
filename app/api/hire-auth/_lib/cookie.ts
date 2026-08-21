import type { NextRequest, NextResponse } from 'next/server'
import {
  HIRE_MEMBER_COOKIE,
  HIRE_MEMBER_LEGACY_COOKIE,
} from '@hire/services/memberAuthService'

const LEGACY_COOKIE_DOMAIN = '.interviewprep.guru'

export interface HireMemberRequestCookies {
  current?: string
  legacy?: string
}

export function readHireMemberCookies(req: NextRequest): HireMemberRequestCookies {
  return {
    current: req.cookies.get(HIRE_MEMBER_COOKIE)?.value,
    legacy: req.cookies.get(HIRE_MEMBER_LEGACY_COOKIE)?.value,
  }
}

export function clearLegacyHireMemberCookie(response: NextResponse): void {
  response.cookies.set(HIRE_MEMBER_LEGACY_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    domain: LEGACY_COOKIE_DOMAIN,
    maxAge: 0,
  })
}

export function setHireMemberCookie(
  response: NextResponse,
  rawToken: string,
  expiresAt: Date
): void {
  response.cookies.set(HIRE_MEMBER_COOKIE, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
  clearLegacyHireMemberCookie(response)
}

export function clearHireMemberCookie(response: NextResponse): void {
  response.cookies.set(HIRE_MEMBER_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  clearLegacyHireMemberCookie(response)
}
