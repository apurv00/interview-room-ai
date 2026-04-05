import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'

export const dynamic = 'force-dynamic'

/**
 * GET /api/design/history — Returns the user's previously used design problem IDs.
 * Used by the interview page to avoid repeating problems across sessions.
 */
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  const sessions = await InterviewSession.find({
    userId: session.user.id,
    designProblemId: { $exists: true, $ne: null },
    status: { $in: ['completed', 'in_progress'] },
  })
    .select('designProblemId')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()

  const usedIds = sessions.map((s: any) => s.designProblemId).filter(Boolean)
  const uniqueIds = Array.from(new Set(usedIds))

  return NextResponse.json({
    solvedProblemIds: uniqueIds,
    totalSolved: uniqueIds.length,
  })
}
