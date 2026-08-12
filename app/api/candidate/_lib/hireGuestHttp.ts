import { NextRequest, NextResponse } from 'next/server'
import {
  HIRE_GUEST_COOKIE_NAME,
  HIRE_GUEST_CSRF_HEADER,
  HireGuestAccessError,
  resolveHireGuestSession,
} from '@hire/services/identityConsentService'
import { HireIdentityMediaError } from '@hire/services/identityMediaService'

export async function requireHireGuest(req: NextRequest, roundId: string) {
  return resolveHireGuestSession({
    roundId,
    credential: req.cookies.get(HIRE_GUEST_COOKIE_NAME)?.value,
    csrfToken: req.headers.get(HIRE_GUEST_CSRF_HEADER) ?? undefined,
  })
}

export function hireGuestErrorResponse(error: unknown): NextResponse {
  if (error instanceof HireGuestAccessError || error instanceof HireIdentityMediaError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    )
  }
  return NextResponse.json(
    { error: 'The interview request could not be completed', code: 'HIRE_GUEST_FAILED' },
    { status: 500 },
  )
}

export function setHireGuestCookie(
  response: NextResponse,
  credential: string,
  expiresAt: Date,
): void {
  response.cookies.set(HIRE_GUEST_COOKIE_NAME, credential, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}
