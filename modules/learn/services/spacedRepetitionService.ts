import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { UserCompetencyState } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

// ─── SM-2 Algorithm ─────────────────────────────────────────────────────────

/**
 * Maps a competency score (0-100) to SM-2 quality (0-5).
 */
export function scoreToQuality(score: number): number {
  if (score >= 86) return 5
  if (score >= 76) return 4
  if (score >= 66) return 3
  if (score >= 56) return 2
  if (score >= 41) return 1
  return 0
}

/**
 * Calculates the next review schedule using SM-2 algorithm.
 */
export function calculateNextReview(input: {
  quality: number
  repetitionCount: number
  interval: number
  easeFactor: number
}): {
  interval: number
  easeFactor: number
  repetitionCount: number
  nextReviewAt: Date
} {
  let { quality, repetitionCount, interval, easeFactor } = input

  if (quality >= 3) {
    // Successful review
    if (repetitionCount === 0) {
      interval = 1
    } else if (repetitionCount === 1) {
      interval = 3
    } else {
      interval = Math.round(interval * easeFactor)
    }
    repetitionCount += 1
  } else {
    // Failed review — reset
    repetitionCount = 0
    interval = 1
  }

  // Update ease factor (never below 1.3)
  easeFactor = Math.max(
    1.3,
    easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  )

  const nextReviewAt = new Date()
  nextReviewAt.setDate(nextReviewAt.getDate() + interval)

  return { interval, easeFactor, repetitionCount, nextReviewAt }
}

// ─── Update SR State After Session ──────────────────────────────────────────

interface SRUpdateInput {
  userId: string
  sessionId: string
  domain: string
  competencyScores: Record<string, number>  // competencyName → average score
}

export async function updateAfterSession(input: SRUpdateInput): Promise<void> {
  if (!isFeatureEnabled('spaced_repetition')) return

  try {
    await connectDB()
    const { userId, domain, competencyScores } = input
    const userObjectId = new mongoose.Types.ObjectId(userId)

    for (const [competencyName, score] of Object.entries(competencyScores)) {
      const quality = scoreToQuality(score)

      const state = await UserCompetencyState.findOne({
        userId: userObjectId,
        competencyName,
        domain,
      })

      if (!state) continue  // Only update SR for existing competencies

      const currentSR = {
        repetitionCount: state.srRepetitionCount ?? 0,
        interval: state.srInterval ?? 1,
        easeFactor: state.srEaseFactor ?? 2.5,
      }

      const next = calculateNextReview({
        quality,
        ...currentSR,
      })

      await UserCompetencyState.updateOne(
        { _id: state._id },
        {
          $set: {
            srLastPracticedAt: new Date(),
            srNextReviewAt: next.nextReviewAt,
            srEaseFactor: next.easeFactor,
            srInterval: next.interval,
            srRepetitionCount: next.repetitionCount,
          },
        }
      )
    }
  } catch (err) {
    logger.error({ err }, 'Failed to update spaced repetition state')
  }
}

// ─── Get Due Competencies ───────────────────────────────────────────────────

export type ReviewUrgency = 'overdue_critical' | 'overdue' | 'due_today' | 'upcoming'

export interface DueCompetency {
  competencyName: string
  domain: string
  currentScore: number
  trend: string
  nextReviewAt: Date
  urgency: ReviewUrgency
  daysPastDue: number
}

export async function getDueCompetencies(userId: string, domain?: string): Promise<DueCompetency[]> {
  if (!isFeatureEnabled('spaced_repetition')) return []

  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(userId),
      srNextReviewAt: { $exists: true },
    }
    if (domain) filter.domain = { $in: [domain, '*'] }

    const states = await UserCompetencyState.find(filter)
      .sort({ srNextReviewAt: 1 })
      .lean()

    const now = new Date()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    const results: DueCompetency[] = []
    for (const s of states) {
      const nextReview = s.srNextReviewAt
      if (!nextReview) continue

      const reviewDate = new Date(nextReview)
      const daysDiff = Math.floor((reviewDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

      if (daysDiff > 3) continue

      let urgency: ReviewUrgency
      if (daysDiff < -7) urgency = 'overdue_critical'
      else if (daysDiff < 0) urgency = 'overdue'
      else if (daysDiff === 0) urgency = 'due_today'
      else urgency = 'upcoming'

      results.push({
        competencyName: s.competencyName,
        domain: s.domain,
        currentScore: s.currentScore,
        trend: s.trend,
        nextReviewAt: reviewDate,
        urgency,
        daysPastDue: Math.max(0, -daysDiff),
      })
    }

    const urgencyOrder: Record<ReviewUrgency, number> = {
      overdue_critical: 0, overdue: 1, due_today: 2, upcoming: 3,
    }
    return results.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency])
  } catch (err) {
    logger.error({ err }, 'Failed to get due competencies')
    return []
  }
}
