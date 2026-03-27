import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, SessionSummary, UserBadge, DailyChallengeAttempt } from '@shared/db/models'
import { sendEmail } from '@shared/services/emailService'
import { aiLogger as logger } from '@shared/logger'
import type { IUser } from '@shared/db/models'
import { getXpSummary } from './xpService'
import { getStreakCalendar } from './streakService'
import { BADGE_DEFINITIONS } from '@learn/config/badges'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000
const APP_URL = process.env.NEXTAUTH_URL || 'https://interviewprep.guru'

/**
 * Check if user is eligible for a digest email.
 */
export async function evaluateDigestEligibility(user: IUser): Promise<boolean> {
  // Must have email preferences enabled
  const prefs = user.emailPreferences
  if (!prefs?.digest) return false

  // Must have completed at least one session
  if (user.interviewCount < 1) return false

  return true
}

/**
 * Build digest email content for a user.
 */
export async function buildDigestContent(userId: string): Promise<{
  subject: string
  html: string
} | null> {
  try {
    await connectDB()

    const uid = new mongoose.Types.ObjectId(userId)

    // Get recent summaries
    const summaries = await SessionSummary.find({ userId: uid })
      .sort({ sessionDate: -1 })
      .limit(5)
      .select('overallScore domain weaknesses sessionDate')
      .lean()

    if (summaries.length === 0) return null

    const user = await User.findById(uid).select('name currentStreak longestStreak').lean()
    const name = user?.name?.split(' ')[0] || 'there'
    const streak = user?.currentStreak || 0

    const latestScore = summaries[0].overallScore
    const avgScore = Math.round(
      summaries.reduce((a, s) => a + s.overallScore, 0) / summaries.length
    )
    const weakAreas = summaries
      .flatMap(s => s.weaknesses || [])
      .slice(0, 3)

    // Fetch engagement data (graceful degradation)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const [xpSummary, recentBadges, streakCalendar, challengeAttempts] = await Promise.all([
      getXpSummary(userId).catch(() => null),
      UserBadge.find({ userId: uid, earnedAt: { $gte: oneWeekAgo } }).lean().catch(() => []),
      getStreakCalendar(userId, 1).catch(() => []),
      DailyChallengeAttempt.find({ userId: uid, createdAt: { $gte: oneWeekAgo } }).lean().catch(() => []),
    ])

    // Badge names
    const earnedBadgeNames = recentBadges.map(b => {
      const def = BADGE_DEFINITIONS.find(d => d.id === b.badgeId)
      return def ? `${def.icon} ${def.name}` : b.badgeId
    })

    // Daily challenge stats
    const challengeCount = challengeAttempts.length
    const bestChallengeScore = challengeAttempts.length > 0
      ? Math.max(...challengeAttempts.map(a => a.score))
      : 0

    // Dynamic subject line
    let subject: string
    if (earnedBadgeNames.length > 0) {
      subject = `${earnedBadgeNames.length} badge${earnedBadgeNames.length !== 1 ? 's' : ''} earned — your weekly recap`
    } else if (xpSummary && xpSummary.xpThisWeek > 0) {
      subject = `You earned ${xpSummary.xpThisWeek} XP this week!`
    } else if (streak > 0) {
      subject = `Keep your ${streak}-day streak alive!`
    } else {
      subject = `Your weekly interview prep update`
    }

    // Streak calendar mini visualization (7 days)
    const last7Days = streakCalendar.slice(0, 7)
    const calendarSquares = last7Days.map(d =>
      d.type === 'active'
        ? '<span style="display:inline-block;width:14px;height:14px;background:#22c55e;border-radius:3px;margin-right:3px;"></span>'
        : d.type === 'freeze'
          ? '<span style="display:inline-block;width:14px;height:14px;background:#3b82f6;border-radius:3px;margin-right:3px;opacity:0.5;"></span>'
          : '<span style="display:inline-block;width:14px;height:14px;background:#e1e8ed;border-radius:3px;margin-right:3px;"></span>'
    ).join('')

    // XP progress bar
    const xpProgress = xpSummary
      ? Math.round(((xpSummary.xp - xpSummary.xpForCurrentLevel) / (xpSummary.xpForNextLevel - xpSummary.xpForCurrentLevel)) * 100)
      : 0

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #ffffff; color: #536471; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #0f1419; font-size: 20px; margin-bottom: 16px;">Hey ${name}!</h1>

    ${xpSummary && xpSummary.xpThisWeek > 0 ? `
    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 8px;">XP & Level</h2>
      <p style="margin: 4px 0; font-size: 13px;">You earned <strong style="color: #6366f1;">${xpSummary.xpThisWeek} XP</strong> this week</p>
      <p style="margin: 4px 0; font-size: 13px;">Level <strong style="color: #0f1419;">${xpSummary.level}</strong> — ${xpSummary.title}</p>
      <div style="background: #eff3f4; border-radius: 4px; height: 6px; margin-top: 8px; overflow: hidden;">
        <div style="background: #6366f1; height: 100%; width: ${Math.min(xpProgress, 100)}%; border-radius: 4px;"></div>
      </div>
      <p style="margin: 4px 0 0; font-size: 11px; color: #8b98a5;">${xpSummary.xpToNextLevel} XP to Level ${xpSummary.level + 1}</p>
    </div>
    ` : ''}

    ${earnedBadgeNames.length > 0 ? `
    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 8px;">Badges Earned This Week</h2>
      ${earnedBadgeNames.map(b => `<p style="margin: 4px 0; font-size: 13px;">${b}</p>`).join('')}
    </div>
    ` : ''}

    ${streak > 0 ? `
    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 8px;">🔥 ${streak}-Day Streak</h2>
      <div style="margin-top: 8px;">${calendarSquares || ''}</div>
    </div>
    ` : ''}

    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 12px;">Your Stats</h2>
      <p style="margin: 4px 0; font-size: 13px;">Latest score: <strong style="color: #0f1419;">${latestScore}/100</strong></p>
      <p style="margin: 4px 0; font-size: 13px;">5-session avg: <strong style="color: #0f1419;">${avgScore}/100</strong></p>
      <p style="margin: 4px 0; font-size: 13px;">Sessions completed: <strong style="color: #0f1419;">${summaries.length}</strong></p>
    </div>

    ${challengeCount > 0 ? `
    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 8px;">Daily Challenges</h2>
      <p style="margin: 4px 0; font-size: 13px;">Completed: <strong style="color: #0f1419;">${challengeCount}/7</strong> this week</p>
      <p style="margin: 4px 0; font-size: 13px;">Best score: <strong style="color: #0f1419;">${bestChallengeScore}/100</strong></p>
    </div>
    ` : ''}

    ${weakAreas.length > 0 ? `
    <div style="background: #f7f9f9; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #0f1419; font-size: 14px; margin: 0 0 8px;">Areas to Focus On</h2>
      ${weakAreas.map(w => `<p style="margin: 4px 0; font-size: 13px; color: #fbbf24;">• ${w}</p>`).join('')}
    </div>
    ` : ''}

    <a href="${APP_URL}/lobby" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; margin-top: 16px;">
      Start Practice Session
    </a>

    <p style="font-size: 11px; color: #8b98a5; margin-top: 32px;">
      <a href="${APP_URL}/api/learn/unsubscribe?userId=${userId}&type=digest" style="color: #8b98a5; text-decoration: underline;">Unsubscribe from digest emails</a>
    </p>
  </div>
</body>
</html>`

    return { subject, html }
  } catch (err) {
    logger.error({ err }, 'Failed to build digest content')
    return null
  }
}

/**
 * Send an inactivity nudge email.
 */
export async function sendInactivityNudge(userId: string, email: string, name: string): Promise<boolean> {
  const firstName = name?.split(' ')[0] || 'there'

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #ffffff; color: #536471; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #0f1419; font-size: 20px; margin-bottom: 16px;">Hey ${firstName}, we miss you!</h1>
    <p style="font-size: 14px;">It's been a few days since your last practice session. Even a quick 5-minute drill can help keep your skills sharp.</p>

    <a href="${APP_URL}/practice/drill" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; margin-top: 16px;">
      Quick Drill (5 min)
    </a>

    <p style="font-size: 11px; color: #8b98a5; margin-top: 32px;">
      <a href="${APP_URL}/api/learn/unsubscribe?userId=${userId}&type=reminders" style="color: #8b98a5; text-decoration: underline;">Unsubscribe from reminders</a>
    </p>
  </div>
</body>
</html>`

  return sendEmail({
    to: email,
    subject: 'Time for a quick practice session?',
    html,
  })
}

/**
 * Process eligible users for digest/nudge emails.
 * Called by cron job. Max 100 users per run.
 */
export async function processEmailBatch(): Promise<{ sent: number; errors: number }> {
  let sent = 0
  let errors = 0

  try {
    await connectDB()

    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - THREE_DAYS_MS)

    // Find users eligible for nudges (inactive > 3 days, reminders enabled)
    const inactiveUsers = await User.find({
      'emailPreferences.reminders': true,
      lastSessionDate: { $lt: threeDaysAgo },
      interviewCount: { $gte: 1 },
    })
      .limit(50)
      .select('email name emailPreferences lastSessionDate')
      .lean()

    for (const user of inactiveUsers) {
      try {
        const success = await sendInactivityNudge(
          user._id.toString(),
          user.email,
          user.name,
        )
        if (success) sent++
        else errors++
      } catch {
        errors++
      }
    }

    // Find users eligible for weekly digest
    const digestUsers = await User.find({
      'emailPreferences.digest': true,
      interviewCount: { $gte: 1 },
    })
      .limit(50)
      .select('email name emailPreferences interviewCount')
      .lean()

    for (const user of digestUsers) {
      if (!await evaluateDigestEligibility(user as IUser)) continue
      try {
        const content = await buildDigestContent(user._id.toString())
        if (content) {
          const success = await sendEmail({
            to: user.email,
            subject: content.subject,
            html: content.html,
          })
          if (success) sent++
          else errors++
        }
      } catch {
        errors++
      }
    }
  } catch (err) {
    logger.error({ err }, 'Email batch processing failed')
  }

  return { sent, errors }
}
