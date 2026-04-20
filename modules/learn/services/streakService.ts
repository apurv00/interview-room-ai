import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import { StreakDay } from '@shared/db/models/StreakDay'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'

function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0]
}

function getYesterdayUTC(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().split('T')[0]
}

/**
 * Record a user activity for today (upsert StreakDay).
 */
export async function recordActivity(userId: string): Promise<void> {
  if (!isFeatureEnabled('engagement_streaks_v2')) return

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)
    const today = getTodayUTC()

    await StreakDay.updateOne(
      { userId: uid, date: today },
      { $inc: { activities: 1 }, $setOnInsert: { type: 'active', userId: uid, date: today } },
      { upsert: true },
    )
  } catch (err) {
    logger.error({ err, userId }, 'Failed to record activity')
  }
}

/**
 * Update the user's streak. Called after recording activity.
 * Handles streak freeze logic: if user missed yesterday but has a freeze available,
 * auto-consume it and keep the streak alive.
 */
export async function updateStreak(userId: string): Promise<{
  currentStreak: number
  longestStreak: number
  frozeToday: boolean
}> {
  const defaultResult = { currentStreak: 0, longestStreak: 0, frozeToday: false }
  if (!isFeatureEnabled('engagement_streaks_v2')) return defaultResult

  try {
    await connectDB()
    const uid = new mongoose.Types.ObjectId(userId)
    const today = getTodayUTC()
    const yesterday = getYesterdayUTC()

    const user = await User.findById(uid)
      .select('currentStreak longestStreak lastSessionDate streakFreezeAvailable')
      .lean()

    if (!user) return defaultResult

    // Check if we have activity today
    const todayActivity = await StreakDay.findOne({ userId: uid, date: today }).lean()
    if (!todayActivity) return defaultResult

    // Check yesterday
    const yesterdayActivity = await StreakDay.findOne({ userId: uid, date: yesterday }).lean()

    let currentStreak = user.currentStreak || 0
    let frozeToday = false

    if (yesterdayActivity) {
      // User was active yesterday — increment streak
      currentStreak = currentStreak + 1
    } else if ((user.streakFreezeAvailable || 0) > 0) {
      // No activity yesterday but freeze available — use it
      await StreakDay.updateOne(
        { userId: uid, date: yesterday },
        { $setOnInsert: { type: 'freeze', activities: 0, userId: uid, date: yesterday } },
        { upsert: true },
      )
      await User.updateOne({ _id: uid }, {
        $inc: { streakFreezeAvailable: -1 },
        streakFreezeUsedAt: new Date(),
      })
      currentStreak = currentStreak + 1
      frozeToday = true
    } else {
      // Streak broken — reset to 1 (today counts)
      currentStreak = 1
    }

    const longestStreak = Math.max(user.longestStreak || 0, currentStreak)

    await User.updateOne({ _id: uid }, {
      currentStreak,
      longestStreak,
      lastSessionDate: new Date(),
    })

    return { currentStreak, longestStreak, frozeToday }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to update streak')
    return defaultResult
  }
}

/**
 * Get streak calendar data for heatmap display.
 */
export async function getStreakCalendar(userId: string, days = 90): Promise<Array<{
  date: string
  type: 'active' | 'freeze'
  activities: number
}>> {
  try {
    await connectDB()
    const startDate = new Date()
    startDate.setUTCDate(startDate.getUTCDate() - days)
    const startStr = startDate.toISOString().split('T')[0]

    const streakDays = await StreakDay.find({
      userId: new mongoose.Types.ObjectId(userId),
      date: { $gte: startStr },
    })
      .sort({ date: -1 })
      .select('date type activities')
      .lean()

    return streakDays.map(d => ({
      date: d.date,
      type: d.type,
      activities: d.activities,
    }))
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get streak calendar')
    return []
  }
}

/**
 * Refresh weekly freeze for a user (1 freeze per week for all users).
 */
export async function refreshWeeklyFreeze(userId: string): Promise<void> {
  try {
    await connectDB()
    await User.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { streakFreezeAvailable: 1, streakFreezeResetAt: getNextMonday() },
    )
  } catch (err) {
    logger.error({ err, userId }, 'Failed to refresh weekly freeze')
  }
}

function getNextMonday(): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(0, 0, 0, 0)
  return d
}
