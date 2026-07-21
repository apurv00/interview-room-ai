import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { getBaseResume } from '@jobs'
import { getResume } from '@resume'
import { computeQuickWins } from '@jobs/config/quickWins'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

/**
 * GET /api/jobs/quick-wins — deterministic wins over the caller's base
 * resume (package 10; zero LLM). 401 anon (the feed card hides), empty
 * when no base resume exists.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  await connectDB()
  if (!(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401 },
    )
  }
  const base = await getBaseResume(userId)
  if (!base) {
    if (!(await isJobsAccountActive(userId))) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    return NextResponse.json({ count: 0, wins: [] })
  }
  const full = await getResume(userId, base.id)
  if (!full) {
    if (!(await isJobsAccountActive(userId))) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    return NextResponse.json({ count: 0, wins: [] })
  }
  const wins = computeQuickWins(full as never)
  if (!(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401 },
    )
  }
  return NextResponse.json({ count: wins.length, wins, resumeId: base.id })
}
