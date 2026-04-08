import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { InterviewSession } from '@shared/db/models/InterviewSession'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/analysis/[sessionId]/reset
 *
 * Manual escape hatch for stuck multimodal analysis runs. Deletes the
 * MultimodalAnalysis row regardless of status (pending / processing /
 * failed / completed) so the user can re-trigger from scratch. The
 * `start` route also auto-recovers records older than 10 minutes; this
 * endpoint exists for the case where a user wants to retry sooner.
 *
 * Auth: only the session owner can reset.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { sessionId } = params
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
  }

  await connectDB()

  // Ownership check via the InterviewSession (analysis records may be
  // missing the userId field on legacy rows, so verify against the parent).
  const ownsSession = await InterviewSession.exists({
    _id: sessionId,
    userId: session.user.id,
  })
  if (!ownsSession) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const result = await MultimodalAnalysis.deleteOne({ sessionId })

  // Also clear the back-reference on the interview session so the replay
  // page doesn't keep pointing at a now-deleted analysis row.
  await InterviewSession.updateOne(
    { _id: sessionId },
    { $unset: { multimodalAnalysisId: 1 } }
  )

  return NextResponse.json({
    success: true,
    deleted: result.deletedCount > 0,
  })
}
