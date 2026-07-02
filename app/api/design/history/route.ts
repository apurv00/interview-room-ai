import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { getServedProblemIds, unionMostRecentFirst } from '@interview/services/core/servedProblemLedger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/design/history — Returns the user's previously used design problem IDs.
 * Used by the interview page to avoid repeating problems across sessions.
 *
 * Union of two records: the ServedProblem ledger (server-authoritative —
 * written at selection/generation time, survives client failures) and the
 * legacy InterviewSession.designProblemId field (client-PATCHed at session
 * start; kept as a redundant record and for pre-ledger history).
 */
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()

  const [ledgerIds, sessions] = await Promise.all([
    getServedProblemIds(session.user.id, 'system-design'),
    InterviewSession.find({
      userId: session.user.id,
      designProblemId: { $exists: true, $ne: null },
      status: { $in: ['completed', 'in_progress'] },
    })
      .select('designProblemId')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ])

  const sessionIds = sessions.map((s: any) => s.designProblemId).filter(Boolean)
  // Ledger first (most-recent-first, server-authoritative), legacy after; deduped.
  // Capped at 200 — the generate-problem Zod schema rejects larger arrays and
  // the client posts this list straight back to it (Codex P2 on #485; see
  // /api/code/history for the full rationale).
  // Per-item cap mirrors the generate routes' 64-char Zod item limit (see
  // /api/code/history for the rationale).
  const uniqueIds = unionMostRecentFirst(ledgerIds, sessionIds)
    .filter((id) => id.length <= 64)
    .slice(0, 200)

  return NextResponse.json({
    solvedProblemIds: uniqueIds,
    totalSolved: uniqueIds.length,
  })
}
