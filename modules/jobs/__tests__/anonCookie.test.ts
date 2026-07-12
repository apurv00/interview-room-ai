import { describe, it, expect } from 'vitest'
import { mintAnonCookie, verifyAnonCookie, anonIdFromCookieHeader, ANON_COOKIE } from '@jobs'

describe('signed anon cookie (CGNAT ruling — cookie identity, never IP)', () => {
  it('mints a verifiable cookie', () => {
    const { anonId, cookieValue } = mintAnonCookie()
    expect(verifyAnonCookie(cookieValue)).toBe(anonId)
  })

  it('rejects tampered ids and signatures — treated as absent, never trusted', () => {
    const { anonId, cookieValue } = mintAnonCookie()
    const sig = cookieValue.slice(cookieValue.lastIndexOf('.') + 1)
    expect(verifyAnonCookie(`${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.${sig}`)).toBeNull()
    expect(verifyAnonCookie(`${anonId}.${'f'.repeat(32)}`)).toBeNull()
    expect(verifyAnonCookie('garbage')).toBeNull()
    expect(verifyAnonCookie(undefined)).toBeNull()
  })

  it('extracts from a raw Cookie header among other cookies', () => {
    const { anonId, cookieValue } = mintAnonCookie()
    expect(anonIdFromCookieHeader(`theme=dark; ${ANON_COOKIE}=${cookieValue}; x=1`)).toBe(anonId)
    expect(anonIdFromCookieHeader('theme=dark')).toBeNull()
    expect(anonIdFromCookieHeader(null)).toBeNull()
  })
})
