import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { getTracker } from '@jobs'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
} from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

/**
 * GET /api/jobs/tracker — the grouped application list (Wave 4.2). All
 * time-derived state (nudges, the P-4 35-day lazy auto-ghost, the confirm
 * card) is computed inside getTracker at read time; no cron exists.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  await connectDB()
  let tracker: Awaited<ReturnType<typeof getTracker>>
  try {
    tracker = await getTracker(userId)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
  if (!(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401 },
    )
  }
  return NextResponse.json(tracker)
}
