import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getTodaysChallenge, submitChallengeAnswer, hasUserCompletedToday } from '@learn/services/dailyChallengeService'
import { awardXp } from '@learn/services/xpService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { XP_AMOUNTS } from '@learn/config/xpTable'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [challenge, completed] = await Promise.all([
      getTodaysChallenge(),
      hasUserCompletedToday(session.user.id),
    ])

    if (!challenge) {
      return NextResponse.json({ error: 'Daily challenge unavailable' }, { status: 503 })
    }

    return NextResponse.json({ ...challenge, completed })
  } catch {
    return NextResponse.json({ error: 'Failed to load challenge' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { answer } = body

    if (!answer || typeof answer !== 'string' || answer.length < 10) {
      return NextResponse.json({ error: 'Answer must be at least 10 characters' }, { status: 400 })
    }

    const today = new Date().toISOString().split('T')[0]
    const result = await submitChallengeAnswer(session.user.id, today, answer)

    if (!result) {
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    // Award XP
    let bonusXp = 0
    if (result.percentile >= 75) {
      bonusXp = XP_AMOUNTS.daily_challenge_top_quartile_bonus
    }
    await awardXp(session.user.id, 'daily_challenge', XP_AMOUNTS.daily_challenge + bonusXp, {
      date: today,
      score: result.score,
    })

    // Record activity for streak
    await recordActivity(session.user.id)
    const streakResult = await updateStreak(session.user.id)

    // Check badges
    await checkAndAwardBadges(session.user.id, {
      type: 'daily_challenge',
      score: result.score,
      currentStreak: streakResult.currentStreak,
    })

    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
  }
}
