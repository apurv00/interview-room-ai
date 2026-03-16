import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { ZodError } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { UpdateSessionSchema } from '@interview/validators/interview'
import { getSession, updateSession } from '@interview/services/interviewService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const interviewSession = await getSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId
    )

    // Strip internal storage keys from response to prevent presigned URL abuse
    const responseData = interviewSession.toObject ? interviewSession.toObject() : { ...interviewSession }
    delete responseData.recordingR2Key

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
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const validated = UpdateSessionSchema.parse(body)

    const updated = await updateSession(
      params.id,
      session.user.id,
      session.user.role,
      session.user.organizationId,
      validated
    )

    // Award XP and update streak when interview is completed
    if (validated.status === 'completed') {
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
