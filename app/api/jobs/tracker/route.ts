import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { getTracker } from '@jobs'

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
  return NextResponse.json(await getTracker(userId))
}
