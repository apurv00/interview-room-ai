import crypto from 'crypto'

/**
 * Signed anonymous-identity cookie (PRODUCT_FLOW §2; CGNAT ruling — signed
 * cookie primary, never IP: Jio/Airtel CGNAT collapses whole cities onto
 * shared IPs). Cookie value is `<uuid>.<hmac(uuid)>`; an invalid signature
 * is treated as ABSENT and re-minted, never trusted.
 */

export const ANON_COOKIE = 'ipg_anon'
export const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 400 // 400d — outlives the funnel

function anonSecret(): string {
  // NEXTAUTH_SECRET is a hard-required env (the app cannot boot without it).
  return process.env.NEXTAUTH_SECRET || 'dev-only-fallback'
}

export function signAnonId(id: string): string {
  return crypto.createHmac('sha256', anonSecret()).update(id).digest('hex').slice(0, 32)
}

export function mintAnonCookie(): { anonId: string; cookieValue: string } {
  const anonId = crypto.randomUUID()
  return { anonId, cookieValue: `${anonId}.${signAnonId(anonId)}` }
}

export function verifyAnonCookie(raw: string | undefined): string | null {
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const id = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const expected = signAnonId(id)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return id
}

/** Extract and verify the anon id from a raw Cookie header. */
export function anonIdFromCookieHeader(cookieHeader: string | null): string | null {
  const raw = (cookieHeader || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${ANON_COOKIE}=`))
    ?.slice(ANON_COOKIE.length + 1)
  return verifyAnonCookie(raw)
}
