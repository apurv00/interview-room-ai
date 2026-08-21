import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV
  vi.resetModules()
})

describe('Hire member cookie contract', () => {
  it('sets a production __Host cookie and expires the legacy domain cookie', async () => {
    process.env.NODE_ENV = 'production'
    vi.resetModules()
    const { HIRE_MEMBER_COOKIE } = await import(
      '@hire/services/memberAuthService'
    )
    const { setHireMemberCookie } = await import('../_lib/cookie')
    const response = NextResponse.json({ ok: true })

    setHireMemberCookie(
      response,
      `a`.repeat(24) + '.' + `b`.repeat(64),
      new Date('2026-08-28T00:00:00.000Z'),
    )

    expect(HIRE_MEMBER_COOKIE).toBe('__Host-ipg-hire-member')
    const header = response.headers.get('set-cookie') ?? ''
    const hostCookie = header.slice(
      header.indexOf('__Host-ipg-hire-member='),
      header.indexOf('__Secure-ipg-hire-member='),
    )
    expect(hostCookie).toContain('Path=/')
    expect(hostCookie).toContain('HttpOnly')
    expect(hostCookie).toContain('Secure')
    expect(hostCookie).toContain('SameSite=lax')
    expect(hostCookie).not.toContain('Domain=')
    expect(header).toContain('__Secure-ipg-hire-member=')
    expect(header).toContain('Domain=.interviewprep.guru')
    expect(header).toContain('Max-Age=0')
  })

  it('clears both the current host-only and legacy domain cookies', async () => {
    process.env.NODE_ENV = 'production'
    vi.resetModules()
    const { clearHireMemberCookie } = await import('../_lib/cookie')
    const response = NextResponse.json({ ok: true })

    clearHireMemberCookie(response)

    const header = response.headers.get('set-cookie') ?? ''
    expect(header).toContain('__Host-ipg-hire-member=')
    expect(header).toContain('__Secure-ipg-hire-member=')
    expect(header.match(/Max-Age=0/g)).toHaveLength(2)
  })

  it('keeps the local cookie usable without Secure or Domain', async () => {
    process.env.NODE_ENV = 'test'
    vi.resetModules()
    const { HIRE_MEMBER_COOKIE } = await import(
      '@hire/services/memberAuthService'
    )
    const { setHireMemberCookie } = await import('../_lib/cookie')
    const response = NextResponse.json({ ok: true })

    setHireMemberCookie(
      response,
      `a`.repeat(24) + '.' + `b`.repeat(64),
      new Date('2026-08-28T00:00:00.000Z'),
    )

    expect(HIRE_MEMBER_COOKIE).toBe('ipg-hire-member')
    const header = response.headers.get('set-cookie') ?? ''
    const localCookie = header.slice(
      header.indexOf('ipg-hire-member='),
      header.indexOf('__Secure-ipg-hire-member='),
    )
    expect(localCookie).toContain('Path=/')
    expect(localCookie).not.toContain('Secure')
    expect(localCookie).not.toContain('Domain=')
  })
})
