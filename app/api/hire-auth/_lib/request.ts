import type { NextRequest } from 'next/server'

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
    if (process.env.NODE_ENV !== 'production') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    }
    const allowed = new URL(
      process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru'
    )
    return url.protocol === 'https:' && url.host === allowed.host
  } catch {
    return false
  }
}
