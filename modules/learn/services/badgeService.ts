import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { UserBadge } from '@shared/db/models/UserBadge'
import { User } from '@shared/db/models/User'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { DailyChallengeAttempt } from '@shared/db/models/DailyChallengeAttempt'
import { BADGE_DEFINITIONS, getBadgesByTrigger } from '@learn/config/badges'
import type { BadgeDef, BadgeTriggerType, BadgeCheckContext } from '@learn/config/badges'
import { awardXp } from './xpService'
import { invalidateUnnotifiedBadgesCache } from './badgeCacheUtils'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'

export interface AwardedBadge {
  badgeId: string
  name: string
  icon: string
  xpReward: number
  rarity: string
}

export interface BadgeTrigger {
  type: BadgeTriggerType
  score?: number
  previousScore?: number
  currentStreak?: number
  graduatedPhase?: string
  consecutiveAtTarget?: number
  masteredCompetency?: string
}

/**
 * Check and award any newly qualified badges for a user.
 */
export async function checkAndAwardBadges(
  userId: string,
  trigger: BadgeTrigger,
): Promise<AwardedBadge[]> {
  if (!isFeatureEnabled('engagement_badges')) return []

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)

    // Get badges already earned
    const earnedBadges = await UserBadge.find({ userId: uid })
      .select('badgeId')
      .lean()
    const earnedSet = new Set(earnedBadges.map(b => b.badgeId))

    // Get candidate badges for this trigger type
    const candidates = getBadgesByTrigger(trigger.type)
    const unearnedCandidates = candidates.filter(b => !earnedSet.has(b.id))
    if (unearnedCandidates.length === 0) return []

    // Build context for badge checks
    const ctx = await buildBadgeContext(userId, trigger)

    const awarded: AwardedBadge[] = []
    for (const badge of unearnedCandidates) {
      if (badge.check(ctx)) {
        try {
          await UserBadge.create({
            userId: uid,
            badgeId: badge.id,
            earnedAt: new Date(),
            notified: false,
          })

          // Award XP for earning badge
          await awardXp(userId, 'badge_earned', badge.xpReward, { badgeId: badge.id })

          awarded.push({
            badgeId: badge.id,
            name: badge.name,
            icon: badge.icon,
            xpReward: badge.xpReward,
            rarity: badge.rarity,
          })
        } catch (err) {
          // Duplicate key error (already earned) — skip
          if ((err as { code?: number }).code === 11000) continue
          throw err
        }
      }
    }

    if (awarded.length > 0) {
      await invalidateUnnotifiedBadgesCache(userId)
    }

    return awarded
  } catch (err) {
    logger.error({ err, userId, trigger }, 'Failed to check/award badges')
    return []
  }
}

async function buildBadgeContext(userId: string, trigger: BadgeTrigger): Promise<BadgeCheckContext> {
  const uid = new mongoose.Types.ObjectId(userId)

  const [user, domainStats, challengeCount] = await Promise.all([
    User.findById(uid).select('interviewCount currentStreak practiceStats').lean(),
    InterviewSession.distinct('domain', { userId: uid, status: 'completed' }),
    DailyChallengeAttempt.countDocuments({ userId: uid }),
  ])

  // Count distinct depth levels practiced
  const depthLevels = await InterviewSession.distinct('interviewType', { userId: uid, status: 'completed' })

  return {
    userId,
    triggerType: trigger.type,
    interviewCount: user?.interviewCount ?? 0,
    currentStreak: trigger.currentStreak ?? user?.currentStreak ?? 0,
    score: trigger.score,
    previousScore: trigger.previousScore,
    domainCount: domainStats.length,
    depthCount: depthLevels.length,
    dailyChallengeCount: challengeCount,
    graduatedPhase: trigger.graduatedPhase,
    consecutiveAtTarget: trigger.consecutiveAtTarget,
    masteredCompetency: trigger.masteredCompetency,
  }
}

/**
 * Get all badges with earned status for a user.
 */
export async function getUserBadges(userId: string): Promise<{
  earned: Array<BadgeDef & { earnedAt: Date }>
  available: BadgeDef[]
}> {
  try {
    await connectDB()
    const earnedDocs = await UserBadge.find({ userId: new mongoose.Types.ObjectId(userId) })
      .sort({ earnedAt: -1 })
      .lean()

    const earnedMap = new Map(earnedDocs.map(b => [b.badgeId, b.earnedAt]))

    const earned: Array<BadgeDef & { earnedAt: Date }> = []
    const available: BadgeDef[] = []

    for (const badge of BADGE_DEFINITIONS) {
      const earnedAt = earnedMap.get(badge.id)
      if (earnedAt) {
        earned.push({ ...badge, earnedAt })
      } else {
        available.push(badge)
      }
    }

    return { earned, available }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get user badges')
    return { earned: [], available: BADGE_DEFINITIONS }
  }
}

/**
 * Get badges that haven't been shown to the user yet.
 */
export async function getUnnotifiedBadges(userId: string): Promise<Array<{
  badgeId: string
  name: string
  description: string
  icon: string
  xpReward: number
  rarity: string
  earnedAt: Date
}>> {
  try {
    await connectDB()
    const unnotified = await UserBadge.find({
      userId: new mongoose.Types.ObjectId(userId),
      notified: false,
    })
      .sort({ earnedAt: -1 })
      .lean()

    return unnotified.map(ub => {
      const def = BADGE_DEFINITIONS.find(b => b.id === ub.badgeId)
      return {
        badgeId: ub.badgeId,
        name: def?.name || ub.badgeId,
        description: def?.description || '',
        icon: def?.icon || '🏅',
        xpReward: def?.xpReward || 0,
        rarity: def?.rarity || 'common',
        earnedAt: ub.earnedAt,
      }
    })
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get unnotified badges')
    return []
  }
}

/**
 * Mark a badge as notified (shown to user).
 */
export async function markBadgeNotified(userId: string, badgeId: string): Promise<void> {
  try {
    await connectDB()
    await UserBadge.updateOne(
      { userId: new mongoose.Types.ObjectId(userId), badgeId },
      { notified: true },
    )
  } catch (err) {
    logger.error({ err, userId, badgeId }, 'Failed to mark badge notified')
  }
}
