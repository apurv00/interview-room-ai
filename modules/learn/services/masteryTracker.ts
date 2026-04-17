import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { UserCompetencyState } from '@shared/db/models'
import { logger } from '@shared/logger'
import { emitPathwayEvent } from './pathwayEvents'
import {
  isCompetencyMastered,
  MASTERY_SCORE_TARGET,
  MASTERY_CONSECUTIVE_THRESHOLD,
} from './phaseAdvancement'

export interface MasteryUpdateResult {
  competencyName: string
  previousStreak: number
  newStreak: number
  newlyMastered: boolean
}

/**
 * Given the latest session score for a competency, update its consecutive-at-target
 * streak and emit `competency_mastered` if the threshold is crossed for the first time.
 *
 * Rules:
 * - score >= MASTERY_SCORE_TARGET → increment streak
 * - score <  MASTERY_SCORE_TARGET → reset streak to 0
 * - streak crosses threshold AND masteredAt unset → mark mastered + emit event
 */
export async function updateMasteryTracking(
  userId: string,
  competencyName: string,
  latestScore: number,
  domain = '*',
): Promise<MasteryUpdateResult | null> {
  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)

    const state = await UserCompetencyState.findOne({
      userId: uid,
      competencyName,
      domain,
    })
    if (!state) return null

    const previousStreak = state.consecutiveAtTarget ?? 0
    const atTarget = latestScore >= MASTERY_SCORE_TARGET
    const newStreak = atTarget ? previousStreak + 1 : 0

    const alreadyMastered = !!state.masteredAt
    const crossedThreshold =
      !alreadyMastered && isCompetencyMastered(newStreak, MASTERY_CONSECUTIVE_THRESHOLD)

    state.consecutiveAtTarget = newStreak
    if (crossedThreshold) state.masteredAt = new Date()
    await state.save()

    if (crossedThreshold) {
      await emitPathwayEvent({
        type: 'competency_mastered',
        userId,
        timestamp: new Date(),
        payload: {
          competencyName,
          domain,
          consecutiveAtTarget: newStreak,
          score: latestScore,
        },
      })
    }

    return {
      competencyName,
      previousStreak,
      newStreak,
      newlyMastered: crossedThreshold,
    }
  } catch (err) {
    logger.error({ err, userId, competencyName }, 'Mastery tracking update failed')
    return null
  }
}

/**
 * Batch update across multiple competencies from a single session's evaluations.
 */
export async function updateMasteryBatch(
  userId: string,
  scores: Record<string, number>,
  domain = '*',
): Promise<MasteryUpdateResult[]> {
  const results: MasteryUpdateResult[] = []
  for (const [competencyName, score] of Object.entries(scores)) {
    const result = await updateMasteryTracking(userId, competencyName, score, domain)
    if (result) results.push(result)
  }
  return results
}
