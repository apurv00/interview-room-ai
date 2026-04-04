import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/register
 *
 * Email/password registration has been removed.
 * Users should sign in with Google or GitHub instead.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Email/password registration is no longer supported. Please sign in with Google or GitHub.' },
    { status: 410 }
  )
}
