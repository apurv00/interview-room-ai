import type { NextRequest } from 'next/server'

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

export function hasTrustedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return process.env.NODE_ENV !== 'production'
  try {
    const url = new URL(origin)
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return false
    }
    if (process.env.NODE_ENV !== 'production') {
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      )
    }
    const allowed = new URL(
      process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru'
    )
    return url.protocol === 'https:' && url.origin === allowed.origin
  } catch {
    return false
  }
}

/** Safe methods do not mutate workspace state; every other method must carry
 * the browser-generated exact Hire Origin in production. */
export function hasTrustedOriginForMutation(req: NextRequest): boolean {
  return SAFE_HTTP_METHODS.has(req.method.toUpperCase()) || hasTrustedOrigin(req)
}
