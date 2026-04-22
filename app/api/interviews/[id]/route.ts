import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { ZodError } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { UpdateSessionSchema } from '@interview/validators/interview'
import { getSession, updateSession } from '@interview/services/core/interviewService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'
import { deleteInterviewSession } from '@shared/services/accountDeletion'
import { flushUsageBuffer } from '@shared/services/usageBuffer'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const excludeTranscript = req.nextUrl.searchParams.get('excludeTranscript') === 'true'
    const interviewSession = await getSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      { excludeTranscript }
    )

    // Strip internal storage keys from response — expose a boolean flag instead
    const responseData = interviewSession.toObject ? interviewSession.toObject() : { ...interviewSession }
    const hasRecording = !!responseData.recordingR2Key
    const hasScreenRecording = !!responseData.screenRecordingR2Key
    delete responseData.recordingR2Key
    delete responseData.screenRecordingR2Key
    delete responseData.audioRecordingR2Key
    responseData.hasRecording = hasRecording
    responseData.hasScreenRecording = hasScreenRecording

    // Strip PII and non-essential fields for non-owner viewers (recruiters viewing org sessions)
    const isOwner = responseData.userId?.toString() === session.user.id
    if (!isOwner) {
      delete responseData.resumeText
      delete responseData.userAgent
      delete responseData.candidateEmail
      delete responseData.jobDescription
    }

    return NextResponse.json(responseData)
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to get interview session')
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const validated = UpdateSessionSchema.parse(body) as Parameters<typeof updateSession>[4]

    // `updateSession` returns both the updated document AND the session's
    // `priorStatus` (status BEFORE this PATCH applied). We use priorStatus
    // to fire the `interview_complete` engagement rewards below only on
    // the first transition into `'completed'` — subsequent re-PATCHes
    // (degraded-reload F5 after PR #313 stopped persisting the outer-catch
    // fallback, double-submits, retries) are no-ops on rewards. Pulling
    // the prior status from here instead of pre-reading in the route
    // matters because Mongoose is configured with `bufferCommands: false`
    // (shared/db/connection.ts) and `updateSession` is the first caller
    // in this handler that runs `await connectDB()`. A pre-read before
    // that call would throw on cold serverless invocations
    // (Codex P1 on PR #313).
    const { updated, priorStatus } = await updateSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      validated
    )
    const wasAlreadyCompleted = priorStatus === 'completed'

    // Award XP and update streak when interview is completed — ONLY on the
    // first transition. Non-reward side effects (usage buffer flush) stay
    // unconditional — they are idempotent by nature (buffer drains on
    // first call; subsequent calls are no-ops).
    if (validated.status === 'completed') {
      // Flush buffered usage records to Mongo (fire-and-forget, non-fatal)
      void flushUsageBuffer(params.id).catch((err) =>
        logger.warn({ err, sessionId: params.id }, 'Failed to flush usage buffer (non-fatal)'),
      )

      if (!wasAlreadyCompleted) {
        const overallScore = validated.feedback?.overall_score
        try {
          await awardXp(session.user.id, 'interview_complete', XP_AMOUNTS.interview_complete, { sessionId: params.id })
          await recordActivity(session.user.id)
          const streakResult = await updateStreak(session.user.id)
          await checkAndAwardBadges(session.user.id, {
            type: 'interview_complete',
            score: overallScore,
            currentStreak: streakResult.currentStreak,
          })
        } catch (engErr) {
          // Don't fail the interview save if engagement tracking fails
          logger.error({ err: engErr }, 'Engagement tracking failed')
        }
      } else {
        logger.info(
          { sessionId: params.id, userId: session.user.id, event: 'interview_complete_rewards_skipped' },
          'PATCH status=completed on already-completed session; skipping duplicate engagement rewards',
        )
      }
    }

    return NextResponse.json({ success: true, sessionId: updated._id.toString() })
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          ...(process.env.NODE_ENV !== 'production' && {
            details: err.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          }),
        },
        { status: 400 }
      )
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to update interview session')
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 })
  }
}

/**
 * DELETE /api/interviews/[id]
 *
 * Permanently removes a single interview session: the session document,
 * its multimodal analysis, its session summary, and any R2 artefacts
 * (recording, facial landmarks, resume, JD). Verifies ownership.
 *
 * This is the *full* delete used by the /history "Delete" button. The
 * sibling /api/interviews/[id]/data endpoint only redacts sensitive
 * fields and is kept for backwards compatibility with the existing
 * "Forget my data" flow on the feedback page.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const authSession = await getServerSession(authOptions)
    if (!authSession?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await deleteInterviewSession(
      params.id,
      authSession.user.id,
      authSession.user.role === 'platform_admin'
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    if (message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (message === 'Session not found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    if (message === 'Invalid session id') {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to delete interview session')
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
