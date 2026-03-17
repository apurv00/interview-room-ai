import mongoose from 'mongoose'
import { nanoid } from 'nanoid'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { aiLogger as logger } from '@shared/logger'

export interface PublicScorecard {
  domain: string
  interviewType: string
  experience: string
  overallScore: number
  dimensions: {
    answerQuality: number
    communication: number
    engagement: number
  }
  strengths: string[]
  questionCount: number
  duration: number
  createdAt: string
}

const SHARE_EXPIRY_DAYS = 90

/**
 * Generate a share token for a session.
 */
export async function generateShareToken(
  userId: string,
  sessionId: string,
): Promise<{ token: string; url: string } | null> {
  try {
    await connectDB()

    const session = await InterviewSession.findOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      userId: new mongoose.Types.ObjectId(userId),
      status: 'completed',
    })

    if (!session) return null

    // If already shared, return existing token
    if (session.shareToken && session.shareExpiresAt && session.shareExpiresAt > new Date()) {
      return { token: session.shareToken, url: `/scorecard/${session.shareToken}` }
    }

    const token = nanoid(12)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + SHARE_EXPIRY_DAYS)

    await InterviewSession.updateOne(
      { _id: session._id },
      { shareToken: token, isPublic: true, shareExpiresAt: expiresAt },
    )

    return { token, url: `/scorecard/${token}` }
  } catch (err) {
    logger.error({ err }, 'Failed to generate share token')
    return null
  }
}

/**
 * Get public scorecard data (no PII, no transcript).
 */
export async function getPublicScorecard(
  token: string,
): Promise<PublicScorecard | null> {
  try {
    await connectDB()

    const session = await InterviewSession.findOne({
      shareToken: token,
      isPublic: true,
      shareExpiresAt: { $gt: new Date() },
    })
      .select('config feedback evaluations durationActualSeconds createdAt')
      .lean()

    if (!session?.feedback) return null

    const fb = session.feedback
    return {
      domain: session.config?.role || 'General',
      interviewType: session.config?.interviewType || 'screening',
      experience: session.config?.experience || '0-2',
      overallScore: fb.overall_score || 0,
      dimensions: {
        answerQuality: fb.dimensions?.answer_quality?.score || 0,
        communication: fb.dimensions?.communication?.score || 0,
        engagement: fb.dimensions?.engagement_signals?.score || fb.dimensions?.delivery_signals?.score || 0,
      },
      strengths: (fb.dimensions?.answer_quality?.strengths || []).slice(0, 5),
      questionCount: (session.evaluations || []).length,
      duration: session.durationActualSeconds || 0,
      createdAt: session.createdAt.toISOString(),
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get public scorecard')
    return null
  }
}

/**
 * Revoke a share token.
 */
export async function revokeShareToken(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await connectDB()

    const result = await InterviewSession.updateOne(
      {
        _id: new mongoose.Types.ObjectId(sessionId),
        userId: new mongoose.Types.ObjectId(userId),
      },
      { $unset: { shareToken: 1 }, isPublic: false, shareExpiresAt: undefined },
    )

    return result.modifiedCount > 0
  } catch (err) {
    logger.error({ err }, 'Failed to revoke share token')
    return false
  }
}
