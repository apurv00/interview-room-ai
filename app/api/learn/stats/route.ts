import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'

export const dynamic = 'force-dynamic'

/**
 * POST /api/learn/stats — permanent no-op (post-G.15).
 *
 * Pre-G.15 this endpoint was the client-side fire-and-forget path
 * for practice-stats updates from useInterview.ts:862. It computed
 * a running avg from the pre-feedback ad-hoc dimension mean. G.14
 * moved the authoritative write into /api/generate-feedback (using
 * the deterministic feedback.overall_score). G.15 makes that
 * server-side path the only path; this endpoint stays as a 200
 * no-op so the legacy client call (which still fires until G.15d
 * removes it from useInterview) doesn't 404 or surface false
 * errors via its `.catch(() => {})` handler.
 *
 * Auth check is preserved as defense-in-depth — even a no-op
 * route should reject unauthenticated requests so we don't expose
 * a logging vector.
 */
export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({
    success: true,
    skipped: 'g15-noop',
    message: 'practiceStats written server-side by generate-feedback',
  })
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('practiceStats').lean()
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({ practiceStats: user.practiceStats || {} })
}
