import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, SessionSummary } from '@shared/db/models'
import { sendEmail } from '@shared/services/emailService'
import { aiLogger as logger } from '@shared/logger'
import type { IUser } from '@shared/db/models'

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

    const subject = streak > 0
      ? `Keep your ${streak}-day streak alive!`
      : `Your weekly interview prep update`

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0f1a; color: #d1d5db; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #f0f2f5; font-size: 20px; margin-bottom: 16px;">Hey ${name}!</h1>

    ${streak > 0 ? `<p style="color: #34d399; font-size: 14px;">You're on a ${streak}-day practice streak! Keep it up.</p>` : ''}

    <div style="background: #1e293b; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #f0f2f5; font-size: 14px; margin: 0 0 12px;">Your Stats</h2>
      <p style="margin: 4px 0; font-size: 13px;">Latest score: <strong style="color: #f0f2f5;">${latestScore}/100</strong></p>
      <p style="margin: 4px 0; font-size: 13px;">5-session avg: <strong style="color: #f0f2f5;">${avgScore}/100</strong></p>
      <p style="margin: 4px 0; font-size: 13px;">Sessions completed: <strong style="color: #f0f2f5;">${summaries.length}</strong></p>
    </div>

    ${weakAreas.length > 0 ? `
    <div style="background: #1e293b; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <h2 style="color: #f0f2f5; font-size: 14px; margin: 0 0 8px;">Areas to Focus On</h2>
      ${weakAreas.map(w => `<p style="margin: 4px 0; font-size: 13px; color: #fbbf24;">• ${w}</p>`).join('')}
    </div>
    ` : ''}

    <a href="${APP_URL}/lobby" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; margin-top: 16px;">
      Start Practice Session
    </a>

    <p style="font-size: 11px; color: #4b5563; margin-top: 32px;">
      <a href="${APP_URL}/api/learn/unsubscribe?userId=${userId}&type=digest" style="color: #6b7280; text-decoration: underline;">Unsubscribe from digest emails</a>
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
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0f1a; color: #d1d5db; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #f0f2f5; font-size: 20px; margin-bottom: 16px;">Hey ${firstName}, we miss you!</h1>
    <p style="font-size: 14px;">It's been a few days since your last practice session. Even a quick 5-minute drill can help keep your skills sharp.</p>

    <a href="${APP_URL}/practice/drill" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; margin-top: 16px;">
      Quick Drill (5 min)
    </a>

    <p style="font-size: 11px; color: #4b5563; margin-top: 32px;">
      <a href="${APP_URL}/api/learn/unsubscribe?userId=${userId}&type=reminders" style="color: #6b7280; text-decoration: underline;">Unsubscribe from reminders</a>
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
