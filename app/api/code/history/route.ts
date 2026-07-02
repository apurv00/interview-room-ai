import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { getServedProblemIds, unionMostRecentFirst } from '@interview/services/core/servedProblemLedger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/code/history — Returns the user's previously served coding problem IDs.
 * Used by the interview page to avoid repeating problems across sessions.
 *
 * Union of two records: the ServedProblem ledger (server-authoritative —
 * written at selection/generation time, survives client failures) and the
 * legacy InterviewSession.codingProblemId field (client-PATCHed at session
 * start; kept as a redundant record and for pre-ledger history).
 */
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  // Fetch all coding sessions for this user that have a problemId
  const [ledgerIds, sessions] = await Promise.all([
    getServedProblemIds(session.user.id, 'coding'),
    InterviewSession.find({
      userId: session.user.id,
      codingProblemId: { $exists: true, $ne: null },
      status: { $in: ['completed', 'in_progress'] },
    })
      .select('codingProblemId config.role config.experience createdAt')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ])

  const sessionIds = sessions.map((s: any) => s.codingProblemId).filter(Boolean)
  // Ledger first (most-recent-first, server-authoritative), legacy after; deduped.
  const uniqueIds = unionMostRecentFirst(ledgerIds, sessionIds)

  return NextResponse.json({
    solvedProblemIds: uniqueIds,
    totalSolved: uniqueIds.length,
  })
}
