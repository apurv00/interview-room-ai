import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { logger } from '@shared/logger'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

/**
 * GET /api/interviews/last-same-domain-feedback?domain=<role>[&priorTo=<sessionId>]
 *
 * Returns a compact summary of the user's most recent COMPLETED interview
 * in the requested domain — the top-3 improvements + overall score.
 *
 * Two callers, both action-anchored:
 *
 *   - Setup page (Wave 1, feature A): no priorTo. Returns the most recent
 *     completed same-domain session so the Pre-interview Coach Card can
 *     surface "Last time on Product Manager, your top focus was: …" at
 *     the moment the user is configuring another interview.
 *
 *   - Feedback page (Wave 2, feature B): priorTo=<currentSessionId>.
 *     Returns the session IMMEDIATELY BEFORE the current one in the same
 *     domain, so the Post-interview Delta Card can render "Last time
 *     your focus was X; this time it's Y — overall +N" — closing the
 *     action-anchored coaching loop opened by the setup card.
 *
 * Diagnostic-coach product framing: insights live at the moment of
 * action, not on a calendar cadence. The card only renders when
 * same-domain history exists; otherwise the response is
 * `{ feedback: null }` and the card no-ops.
 *
 * Why a dedicated route (not a flag on /api/interviews):
 *   - Tight projection: ships ~6 small fields instead of a full session row
 *   - Simple cache profile: per-user per-domain, can be deduplicated
 *     by the client with `deduplicatedFetch`
 *   - Easy to evolve independently (e.g. add weakest-dimension extraction
 *     later) without touching the broader session-list contract
 */
export async function GET(req: NextRequest) {
  let requesterUserId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    const { searchParams } = new URL(req.url)
    const domain = searchParams.get('domain')?.trim()
    if (!domain || domain.length > INTERVIEW_ROLE_SLUG_MAX_CHARS) {
      return NextResponse.json({ error: 'a valid domain is required' }, { status: 400 })
    }

    // Optional: bound the search to sessions completed BEFORE this one.
    // Used by the Feedback page's Post-interview Delta Card so it can
    // surface "the session immediately before this one" without showing
    // the user their own current session. Invalid id ⇒ ignore the bound
    // (the route still returns the most recent in domain) rather than
    // 400, because the card should degrade silently if the URL is weird.
    const priorTo = searchParams.get('priorTo')?.trim()
    const priorToValid = priorTo && mongoose.Types.ObjectId.isValid(priorTo) ? priorTo : null

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    // Reference timestamp + which field to filter by. The reference and
    // the target row MUST be compared using the same timestamp field
    // (Vercel Agent on PR #381) — otherwise the query mixes completedAt
    // with createdAt and can skip the actual predecessor.
    let refTime: Date | null = null
    let refTimeField: 'completedAt' | 'createdAt' | null = null
    if (priorToValid) {
      const ref = await InterviewSession.findOne({
        _id: new mongoose.Types.ObjectId(priorToValid),
        userId: new mongoose.Types.ObjectId(session.user.id),
      })
        .select({ completedAt: 1, createdAt: 1 })
        .lean<{ completedAt?: Date; createdAt?: Date }>()
      if (ref?.completedAt) {
        refTime = ref.completedAt
        refTimeField = 'completedAt'
      } else if (ref?.createdAt) {
        refTime = ref.createdAt
        refTimeField = 'createdAt'
      }
    }

    // Most recent completed session in this domain with non-degraded feedback.
    // Degraded feedback (LLM failure fallback) carries synthetic scores —
    // surfacing those as "your top focus area" would mislead the user, so
    // we exclude them.
    const filter: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(session.user.id),
      'config.role': domain,
      status: 'completed',
      feedback: { $exists: true, $ne: null },
      'feedback.degraded': { $ne: true },
    }
    if (priorToValid) {
      // Exclude the reference session itself even when its timestamps
      // are missing — covers in-flight rows where _id is the only
      // reliable identity.
      filter._id = { $ne: new mongoose.Types.ObjectId(priorToValid) }
      if (refTime && refTimeField) {
        filter[refTimeField] = { $lt: refTime }
      }
    }

    const doc = await InterviewSession.findOne(filter)
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

    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

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
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the original history failure if this recheck also fails.
      }
    }
    logger.error({ err }, 'Failed to load last same-domain feedback')
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
