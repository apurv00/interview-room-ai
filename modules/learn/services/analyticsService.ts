import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { SessionSummary } from '@shared/db/models'
import { UserCompetencyState } from '@shared/db/models/UserCompetencyState'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import { isFeatureEnabled } from '@shared/featureFlags'
import { aiLogger as logger } from '@shared/logger'

export interface AnalyticsData {
  stats: {
    totalSessions: number
    avgScore: number
    currentStreak: number
    longestStreak: number
  }
  scoreTrend: Array<{
    date: string
    score: number
    domain: string
  }>
  competencyRadar: Array<{
    competency: string
    score: number
    trend: string
  }>
  sessionsPerWeek: Array<{
    week: string
    count: number
  }>
  communicationTrend: Array<{
    date: string
    wpm: number
    fillerRate: number
  }>
}

const EMPTY: AnalyticsData = {
  stats: { totalSessions: 0, avgScore: 0, currentStreak: 0, longestStreak: 0 },
  scoreTrend: [],
  competencyRadar: [],
  sessionsPerWeek: [],
  communicationTrend: [],
}

/**
 * Calculate streak from session dates.
 * A streak counts consecutive days with at least one completed session.
 * A gap > 48h resets the streak.
 */
function calculateStreak(dates: Date[]): { current: number; longest: number } {
  if (dates.length === 0) return { current: 0, longest: 0 }

  // Sort newest first
  const sorted = [...dates].sort((a, b) => b.getTime() - a.getTime())

  let current = 1
  let longest = 1
  let streak = 1

  // Check if most recent session is within 48h of now
  const now = new Date()
  const hoursSinceLast = (now.getTime() - sorted[0].getTime()) / (1000 * 60 * 60)
  if (hoursSinceLast > 48) {
    current = 0
  }

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i - 1].getTime() - sorted[i].getTime()
    const gapHours = gap / (1000 * 60 * 60)

    if (gapHours <= 48) {
      streak++
      longest = Math.max(longest, streak)
      if (current > 0) current = streak
    } else {
      streak = 1
      if (current > 0 && i <= current) {
        // current streak already counted
      }
      current = current > 0 ? current : 0
    }
  }

  longest = Math.max(longest, streak)
  return { current: Math.max(current, 0), longest }
}

export async function getAnalyticsData(
  userId: string,
  period: '7d' | '30d' | 'all' = 'all',
): Promise<AnalyticsData> {
  if (!isFeatureEnabled('session_summaries')) return EMPTY

  try {
    await connectDB()

    const uid = new mongoose.Types.ObjectId(userId)
    const now = new Date()

    // Date filter
    const dateFilter: Record<string, unknown> = {}
    if (period === '7d') {
      dateFilter.sessionDate = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
    } else if (period === '30d') {
      dateFilter.sessionDate = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
    }

    // Fetch data in parallel
    const [summaries, competencies, sessions, user] = await Promise.all([
      // Score time-series
      SessionSummary.find({ userId: uid, ...dateFilter })
        .sort({ sessionDate: 1 })
        .select('overallScore domain sessionDate communicationMarkers')
        .lean(),
      // Competency radar (cross-domain)
      UserCompetencyState.find({ userId: uid, domain: '*' })
        .select('competencyName currentScore trend')
        .lean(),
      // Session dates for streak + frequency
      InterviewSession.find({ userId: uid, status: 'completed' })
        .sort({ completedAt: -1 })
        .select('completedAt')
        .lean(),
      // User for cached streak
      User.findById(uid).select('currentStreak longestStreak').lean(),
    ])

    // Stats
    const scores = summaries.map(s => s.overallScore).filter(s => s > 0)
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0

    // Streak
    const completedDates = sessions
      .map(s => s.completedAt)
      .filter((d): d is Date => d != null)
    const { current, longest } = calculateStreak(completedDates)

    // Update user streak if changed
    if (user && (user.currentStreak !== current || user.longestStreak !== longest)) {
      await User.updateOne(
        { _id: uid },
        { currentStreak: current, longestStreak: longest, lastSessionDate: completedDates[0] },
      )
    }

    // Score trend
    const scoreTrend = summaries.map(s => ({
      date: s.sessionDate.toISOString().split('T')[0],
      score: s.overallScore,
      domain: s.domain,
    }))

    // Competency radar
    const competencyRadar = competencies.map(c => ({
      competency: c.competencyName,
      score: c.currentScore,
      trend: c.trend,
    }))

    // Sessions per week
    const weekMap = new Map<string, number>()
    for (const s of sessions) {
      if (!s.completedAt) continue
      const d = new Date(s.completedAt)
      // Get Monday of that week
      const day = d.getDay()
      const diff = d.getDate() - day + (day === 0 ? -6 : 1)
      const monday = new Date(d)
      monday.setDate(diff)
      const weekKey = monday.toISOString().split('T')[0]
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + 1)
    }
    const sessionsPerWeek = Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12) // last 12 weeks
      .map(([week, count]) => ({ week, count }))

    // Communication trend
    const communicationTrend = summaries
      .filter(s => s.communicationMarkers?.avgWpm)
      .map(s => ({
        date: s.sessionDate.toISOString().split('T')[0],
        wpm: s.communicationMarkers.avgWpm,
        fillerRate: s.communicationMarkers.fillerRate,
      }))

    return {
      stats: {
        totalSessions: summaries.length,
        avgScore,
        currentStreak: current,
        longestStreak: longest,
      },
      scoreTrend,
      competencyRadar,
      sessionsPerWeek,
      communicationTrend,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get analytics data')
    return EMPTY
  }
}
