import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'

export const dynamic = 'force-dynamic'

/**
 * GET /api/code/history — Returns the user's previously solved coding problem IDs.
 * Used by the interview page to avoid repeating problems across sessions.
 */
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  // Fetch all coding sessions for this user that have a problemId
  const sessions = await InterviewSession.find({
    userId: session.user.id,
    codingProblemId: { $exists: true, $ne: null },
    status: { $in: ['completed', 'in_progress'] },
  })
    .select('codingProblemId config.role config.experience createdAt')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()

  const solvedProblemIds = sessions.map((s: any) => s.codingProblemId).filter(Boolean)
  // Deduplicate
  const uniqueIds = Array.from(new Set(solvedProblemIds))

  return NextResponse.json({
    solvedProblemIds: uniqueIds,
    totalSolved: uniqueIds.length,
  })
}
