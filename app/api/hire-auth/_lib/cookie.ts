import type { NextResponse } from 'next/server'
import { HIRE_MEMBER_COOKIE } from '@hire/services/memberAuthService'

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
    ...(process.env.NODE_ENV === 'production'
      ? { domain: '.interviewprep.guru' }
      : {}),
  })
}
export function clearHireMemberCookie(response: NextResponse): void {
  response.cookies.set(HIRE_MEMBER_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    ...(process.env.NODE_ENV === 'production'
      ? { domain: '.interviewprep.guru' }
      : {}),
  })
}
