import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import mongoose from 'mongoose'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const period = searchParams.get('period') || 'all'

  await connectDB()

  // Build date filter
  const dateFilter: Record<string, unknown> = {}
  const now = new Date()
  if (period === '7d') {
    dateFilter.createdAt = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
  } else if (period === '30d') {
    dateFilter.createdAt = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
  }

  const userId = new mongoose.Types.ObjectId(session.user.id)

  // Fetch completed sessions with feedback
  const sessions = await InterviewSession.find({
    userId,
    status: 'completed',
    ...dateFilter,
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('feedback config createdAt durationActualSeconds evaluations speechMetrics')
    .lean()

  // Compute stats
  const completedSessions = sessions.filter((s) => s.feedback?.overall_score)
  const scores = completedSessions.map((s) => s.feedback!.overall_score)

  const stats = {
    totalInterviews: completedSessions.length,
    avgScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    bestScore: scores.length > 0 ? Math.max(...scores) : 0,
    avgDuration: completedSessions.length > 0
      ? Math.round(
          completedSessions.reduce((a, s) => a + (s.durationActualSeconds || 0), 0) /
            completedSessions.length
        )
      : 0,
  }

  // Score trend (last 10, oldest first)
  const trends = completedSessions
    .slice(0, 10)
    .reverse()
    .map((s) => ({
      score: s.feedback!.overall_score,
      answerQuality: s.feedback!.dimensions?.answer_quality?.score || 0,
      communication: s.feedback!.dimensions?.communication?.score || 0,
      delivery: s.feedback!.dimensions?.delivery_signals?.score || 0,
      date: s.createdAt,
      role: s.config?.role,
    }))

  // Weakness analysis: find consistently low dimensions across evaluations
  const dimensionAvgs: Record<string, number[]> = {
    relevance: [],
    structure: [],
    specificity: [],
    ownership: [],
  }

  for (const s of completedSessions.slice(0, 10)) {
    const evals = s.evaluations || []
    if (evals.length === 0) continue
    for (const dim of Object.keys(dimensionAvgs)) {
      const avg =
        evals.reduce((a: number, e: unknown) => {
          const ev = e as Record<string, number>
          return a + (ev[dim] || 0)
        }, 0) / evals.length
      dimensionAvgs[dim].push(avg)
    }
  }

  const weaknesses = Object.entries(dimensionAvgs)
    .map(([dim, scores]) => ({
      dimension: dim,
      avgScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    }))
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, 3)

  // Most improved: compare first half vs second half
  let mostImproved: string | null = null
  if (scores.length >= 4) {
    const half = Math.floor(scores.length / 2)
    const firstHalf = scores.slice(half)  // older sessions (scores is newest-first)
    const secondHalf = scores.slice(0, half)  // newer sessions
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
    const improvement = secondAvg - firstAvg
    if (improvement > 0) {
      mostImproved = `+${Math.round(improvement)} points in recent sessions`
    }
  }

  return NextResponse.json({ stats, trends, weaknesses, mostImproved })
}
