import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function safeOrigin(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value || fallback)
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'interviewprep.guru' &&
        !url.hostname.endsWith('.interviewprep.guru'))
    ) {
      return fallback
    }
    return url.origin
  } catch {
    return fallback
  }
}

/** Authenticate the workspace creator on the B2C origin, then return to the
 * isolated Hire control plane. Direct Hire-member sessions use a host-only
 * cookie and are never shared with the B2C sibling origin. */
export async function GET() {
  const b2cOrigin = safeOrigin(
    process.env.B2C_PUBLIC_URL || process.env.APP_URL,
    'https://www.interviewprep.guru',
  )
  const hireOrigin = safeOrigin(
    process.env.HIRE_PUBLIC_URL,
    'https://hire.interviewprep.guru',
  )
  const destination = new URL('/signin', b2cOrigin)
  destination.searchParams.set('callbackUrl', new URL('/workspace', hireOrigin).toString())
  return NextResponse.redirect(destination)
}
