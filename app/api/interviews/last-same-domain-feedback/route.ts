import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/interviews/last-same-domain-feedback?domain=<role>
 *
 * Returns a compact summary of the user's most recent COMPLETED interview
 * in the requested domain — the top-3 improvements + overall score —
 * so the Setup page's Pre-interview Coach Card (Pathway P2 Wave 1, feature A)
 * can surface "Last time on Product Manager, your top focus was: …"
 * directly at the moment the user is about to take another interview.
 *
 * Diagnostic-coach product framing: insights live at the moment of action,
 * not on a calendar cadence. The card only renders when same-domain
 * history exists; otherwise the response is `{ feedback: null }` and the
 * card no-ops.
 *
 * Why a dedicated route (not a flag on /api/interviews):
 *   - Tight projection: ships ~6 small fields instead of a full session row
 *   - Simple cache profile: per-user per-domain, can be deduplicated
 *     by the client with `deduplicatedFetch`
 *   - Easy to evolve independently (e.g. add weakest-dimension extraction
 *     later) without touching the broader session-list contract
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const domain = searchParams.get('domain')?.trim().slice(0, 50)
    if (!domain) {
      return NextResponse.json({ error: 'domain is required' }, { status: 400 })
    }

    await connectDB()

    // Most recent completed session in this domain with non-degraded feedback.
    // Degraded feedback (LLM failure fallback) carries synthetic scores —
    // surfacing those as "your top focus area" would mislead the user, so
    // we exclude them.
    const doc = await InterviewSession.findOne({
      userId: new mongoose.Types.ObjectId(session.user.id),
      'config.role': domain,
      status: 'completed',
      feedback: { $exists: true, $ne: null },
      'feedback.degraded': { $ne: true },
    })
      .select({
        _id: 1,
        completedAt: 1,
        'config.role': 1,
        'config.interviewType': 1,
        'feedback.overall_score': 1,
        'feedback.top_3_improvements': 1,
      })
      .sort({ completedAt: -1, createdAt: -1 })
      .lean<{
        _id: mongoose.Types.ObjectId
        completedAt?: Date
        config?: { role?: string; interviewType?: string }
        feedback?: { overall_score?: number; top_3_improvements?: string[] }
      }>()

    if (!doc?.feedback || !Array.isArray(doc.feedback.top_3_improvements) || doc.feedback.top_3_improvements.length === 0) {
      return NextResponse.json({ feedback: null })
    }

    return NextResponse.json({
      feedback: {
        sessionId: doc._id.toString(),
        completedAt: doc.completedAt ? doc.completedAt.toISOString() : null,
        domain: doc.config?.role ?? domain,
        interviewType: doc.config?.interviewType ?? null,
        overallScore: typeof doc.feedback.overall_score === 'number' ? doc.feedback.overall_score : null,
        topImprovements: doc.feedback.top_3_improvements.slice(0, 3),
      },
    })
  } catch (err) {
    logger.error({ err }, 'Failed to load last same-domain feedback')
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
