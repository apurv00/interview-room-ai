import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { computePercentile } from '@/lib/peerComparison'

export const dynamic = 'force-dynamic'

const VALID_ROLES = ['PM', 'SWE', 'Sales', 'MBA']
const VALID_EXPERIENCE = ['0-2', '3-6', '7+']
const CACHE_TTL = 21600 // 6 hours in seconds
const USER_SCORE_TTL = 3600 // 1 hour in seconds
const MAX_SCORES = 1000 // Cap allScores array to avoid large cache entries

/**
 * Get user's score for a session, with per-session Redis cache.
 */
async function getCachedUserScore(sessionId: string, userId: string): Promise<number | null> {
  const scoreKey = `peer-score:${sessionId}`

  // Try Redis cache first
  try {
    const cached = await redis.get(scoreKey)
    if (cached !== null) return parseFloat(cached)
  } catch {
    // Fall through to DB
  }

  // Query MongoDB
  try {
    await connectDB()
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId: userId,
    })
      .select('feedback.overall_score')
      .lean()

    const score = (session as any)?.feedback?.overall_score ?? null
    if (score !== null) {
      try {
        await redis.setex(scoreKey, USER_SCORE_TTL, String(score))
      } catch {
        // Non-critical
      }
    }
    return score
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = req.nextUrl
    const role = searchParams.get('role')
    const experience = searchParams.get('experience')
    const sessionId = searchParams.get('sessionId')

    if (!role || !experience) {
      return NextResponse.json({ error: 'role and experience are required' }, { status: 400 })
    }
    if (!VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }
    if (!VALID_EXPERIENCE.includes(experience)) {
      return NextResponse.json({ error: 'Invalid experience' }, { status: 400 })
    }

    // Check Redis cache
    const cacheKey = `peer-comparison:${role}:${experience}`
    let cachedData: {
      available: boolean
      count: number
      averages?: { overall: number; answerQuality: number; communication: number; engagement: number }
      allScores?: number[]
    } | null = null

    try {
      const cached = await redis.get(cacheKey)
      if (cached) {
        cachedData = JSON.parse(cached)
      }
    } catch (err) {
      logger.error({ err }, 'Redis cache read failed for peer comparison')
    }

    if (cachedData) {
      // Compute user-specific percentile from cached data
      if (sessionId && cachedData.available && cachedData.allScores) {
        const userScore = await getCachedUserScore(sessionId, session.user.id)
        if (userScore !== null) {
          return NextResponse.json({
            ...cachedData,
            userScore,
            percentile: computePercentile(cachedData.allScores, userScore),
          })
        }
      }
      return NextResponse.json(cachedData)
    }

    // MongoDB aggregation
    await connectDB()

    const pipeline = [
      {
        $match: {
          status: 'completed',
          'config.role': role,
          'config.experience': experience,
          'feedback.overall_score': { $exists: true },
        },
      },
      {
        // Compute engagement with legacy delivery_signals fallback
        $addFields: {
          _engagementScore: {
            $ifNull: [
              '$feedback.dimensions.engagement_signals.score',
              '$feedback.dimensions.delivery_signals.score',
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgOverall: { $avg: '$feedback.overall_score' },
          avgAnswerQuality: { $avg: '$feedback.dimensions.answer_quality.score' },
          avgCommunication: { $avg: '$feedback.dimensions.communication.score' },
          avgEngagement: { $avg: '$_engagementScore' },
          allScores: { $push: '$feedback.overall_score' },
        },
      },
    ]

    const results = await InterviewSession.aggregate(pipeline)

    if (!results.length || results[0].count < 5) {
      const response = {
        available: false,
        count: results[0]?.count || 0,
      }
      // Cache even empty results (shorter TTL)
      try {
        await redis.setex(cacheKey, 1800, JSON.stringify(response))
      } catch {
        // Non-critical
      }
      return NextResponse.json(response)
    }

    const agg = results[0]
    let sortedScores = [...agg.allScores].sort((a: number, b: number) => a - b)
    // Cap to avoid large cache entries
    if (sortedScores.length > MAX_SCORES) {
      // Sample evenly to preserve distribution shape
      const step = sortedScores.length / MAX_SCORES
      const sampled: number[] = []
      for (let i = 0; i < MAX_SCORES; i++) {
        sampled.push(sortedScores[Math.floor(i * step)])
      }
      sortedScores = sampled
    }

    const responseData = {
      available: true,
      count: agg.count,
      averages: {
        overall: Math.round(agg.avgOverall),
        answerQuality: Math.round(agg.avgAnswerQuality || 0),
        communication: Math.round(agg.avgCommunication || 0),
        engagement: Math.round(agg.avgEngagement || 0),
      },
      allScores: sortedScores,
    }

    // Cache in Redis for 6 hours
    try {
      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(responseData))
    } catch (err) {
      logger.error({ err }, 'Redis cache write failed for peer comparison')
    }

    // Add user-specific percentile
    if (sessionId) {
      const userScore = await getCachedUserScore(sessionId, session.user.id)
      if (userScore !== null) {
        return NextResponse.json({
          ...responseData,
          userScore,
          percentile: computePercentile(sortedScores, userScore),
        })
      }
    }

    return NextResponse.json(responseData)
  } catch (err) {
    logger.error({ err }, 'Failed to get peer comparison data')
    return NextResponse.json({ error: 'Failed to get peer comparison data' }, { status: 500 })
  }
}
