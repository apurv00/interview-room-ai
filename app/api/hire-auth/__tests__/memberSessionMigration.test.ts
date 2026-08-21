import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('@hire/services/memberAuthService', () => ({
  HIRE_MEMBER_COOKIE: '__Host-ipg-hire-member',
  HIRE_MEMBER_LEGACY_COOKIE: '__Secure-ipg-hire-member',
  resolveHireMemberSession: (...args: unknown[]) => mocks.resolve(...args),
  revokeHireMemberSession: (...args: unknown[]) => mocks.revoke(...args),
}))

import {
  applyHireMemberRequestCookies,
  resolveHireMemberRequestSession,
  revokeRequestHireMemberSessions,
} from '../_lib/memberSession'

const CURRENT = `${'1'.repeat(24)}.${'a'.repeat(64)}`
const LEGACY = `${'2'.repeat(24)}.${'b'.repeat(64)}`
const AUTH = {
  workspace: { _id: 'workspace', name: 'Acme' },
  membership: {
    _id: 'member',
    name: 'HR',
    email: 'hr@example.com',
    role: 'member',
  },
}

function request(cookie: string): NextRequest {
  return new NextRequest(
    'https://hire.interviewprep.guru/api/hire-auth/session',
    { headers: { cookie } },
  )
}

describe('legacy Hire member session migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(AUTH)
    mocks.revoke.mockResolvedValue(undefined)
  })

  it('rejects and revokes a legacy-only cookie instead of authenticating a sibling-planted session', async () => {
    const result = await resolveHireMemberRequestSession(
      request(`__Secure-ipg-hire-member=${LEGACY}`),
    )

    expect(mocks.revoke).toHaveBeenCalledWith(LEGACY)
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(result).toEqual({
      auth: null,
      clearLegacyCookie: true,
      clearCurrentCookie: false,
    })

    const response = applyHireMemberRequestCookies(
      NextResponse.json({ ok: true }),
      result,
    )
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).not.toContain('__Host-ipg-hire-member=')
    expect(setCookie).toContain('__Secure-ipg-hire-member=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('keeps a valid host-only session when no legacy cookie is present', async () => {
    const result = await resolveHireMemberRequestSession(
      request(`__Host-ipg-hire-member=${CURRENT}`),
    )

    expect(mocks.resolve).toHaveBeenCalledWith(CURRENT)
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect(result).toEqual({
      auth: AUTH,
      sessionCredential: CURRENT,
      clearLegacyCookie: false,
      clearCurrentCookie: false,
    })
  })

  it('prefers a different host credential and revokes rather than falls back to legacy', async () => {
    const result = await resolveHireMemberRequestSession(
      request(
        `__Host-ipg-hire-member=${CURRENT}; __Secure-ipg-hire-member=${LEGACY}`,
      ),
    )

    expect(mocks.resolve).toHaveBeenCalledWith(CURRENT)
    expect(mocks.revoke).toHaveBeenCalledWith(LEGACY)
    expect(result.sessionCredential).toBe(CURRENT)
    expect(result.clearLegacyCookie).toBe(true)
    expect(result.clearCurrentCookie).toBe(false)
  })

  it('rejects equal host and legacy values because the credential crossed the legacy Domain channel', async () => {
    const result = await resolveHireMemberRequestSession(
      request(
        `__Host-ipg-hire-member=${LEGACY}; __Secure-ipg-hire-member=${LEGACY}`,
      ),
    )

    expect(mocks.revoke).toHaveBeenCalledTimes(1)
    expect(mocks.revoke).toHaveBeenCalledWith(LEGACY)
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(result).toEqual({
      auth: null,
      clearLegacyCookie: true,
      clearCurrentCookie: true,
    })

    const response = applyHireMemberRequestCookies(
      NextResponse.json({ ok: true }),
      result,
    )
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-ipg-hire-member=')
    expect(setCookie).toContain('__Secure-ipg-hire-member=')
    expect(setCookie.match(/Max-Age=0/g)).toHaveLength(2)
  })

  it('revokes both distinct credentials during sign-out', async () => {
    await revokeRequestHireMemberSessions(
      request(
        `__Host-ipg-hire-member=${CURRENT}; __Secure-ipg-hire-member=${LEGACY}`,
      ),
    )

    expect(mocks.revoke).toHaveBeenNthCalledWith(1, CURRENT)
    expect(mocks.revoke).toHaveBeenNthCalledWith(2, LEGACY)
  })
})
