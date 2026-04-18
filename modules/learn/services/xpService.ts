import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import { XpEvent } from '@shared/db/models/XpEvent'
import { calculateLevel } from '@learn/config/xpTable'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'
import { redis } from '@shared/redis'
import type { XpEventType } from '@shared/db/models/XpEvent'

export interface XpAwardResult {
  newXp: number
  newLevel: number
  leveledUp: boolean
  title: string
}

export interface XpSummary {
  xp: number
  level: number
  title: string
  xpToNextLevel: number
  xpThisWeek: number
  xpForCurrentLevel: number
  xpForNextLevel: number
}

/**
 * Award XP to a user. Uses atomic $inc for race-condition safety.
 */
export async function awardXp(
  userId: string,
  type: XpEventType,
  amount: number,
  metadata?: Record<string, unknown>,
): Promise<XpAwardResult> {
  if (!isFeatureEnabled('engagement_xp')) {
    return { newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' }
  }

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)

    // Record the XP event
    await XpEvent.create({
      userId: uid,
      type,
      amount,
      metadata: metadata || {},
    })

    // Atomically increment XP
    const updatedUser = await User.findByIdAndUpdate(
      uid,
      { $inc: { xp: amount, xpThisWeek: amount } },
      { returnDocument: 'after', select: 'xp level' },
    )

    if (!updatedUser) {
      return { newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' }
    }

    const newXp = updatedUser.xp || 0
    const oldLevel = updatedUser.level || 1
    const { level: newLevel, title } = calculateLevel(newXp)

    // Update level if changed
    if (newLevel !== oldLevel) {
      await User.updateOne({ _id: uid }, { level: newLevel })
    }

    // Invalidate cached XP summary
    try { await redis.del(`xp:${userId}`) } catch { /* non-critical */ }

    return {
      newXp,
      newLevel,
      leveledUp: newLevel > oldLevel,
      title,
    }
  } catch (err) {
    logger.error({ err, userId, type, amount }, 'Failed to award XP')
    return { newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' }
  }
}

/**
 * Get XP summary for a user (nav bar display).
 */
export async function getXpSummary(userId: string): Promise<XpSummary> {
  try {
    await connectDB()
    const user = await User.findById(userId)
      .select('xp level xpThisWeek')
      .lean()

    if (!user) {
      return { xp: 0, level: 1, title: 'Novice', xpToNextLevel: 100, xpThisWeek: 0, xpForCurrentLevel: 0, xpForNextLevel: 100 }
    }

    const xp = user.xp || 0
    const { level, title, xpForCurrentLevel, xpForNextLevel } = calculateLevel(xp)

    return {
      xp,
      level,
      title,
      xpToNextLevel: xpForNextLevel - xp,
      xpThisWeek: user.xpThisWeek || 0,
      xpForCurrentLevel,
      xpForNextLevel,
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get XP summary')
    return { xp: 0, level: 1, title: 'Novice', xpToNextLevel: 100, xpThisWeek: 0, xpForCurrentLevel: 0, xpForNextLevel: 100 }
  }
}

/**
 * Get recent XP events for a user.
 */
export async function getXpHistory(userId: string, limit = 20): Promise<Array<{
  type: XpEventType
  amount: number
  metadata: Record<string, unknown>
  createdAt: Date
}>> {
  try {
    await connectDB()
    const events = await XpEvent.find({ userId: new mongoose.Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('type amount metadata createdAt')
      .lean()

    return events.map(e => ({
      type: e.type,
      amount: e.amount,
      metadata: e.metadata || {},
      createdAt: e.createdAt,
    }))
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get XP history')
    return []
  }
}
