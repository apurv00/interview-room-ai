import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getAnalyticsData } from '@learn/services/analyticsService'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const period = (searchParams.get('period') || 'all') as '7d' | '30d' | 'all'

    const data = await getAnalyticsData(session.user.id, period)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json(
      { stats: { totalSessions: 0, avgScore: 0, currentStreak: 0, longestStreak: 0 }, scoreTrend: [], competencyRadar: [], sessionsPerWeek: [], communicationTrend: [] },
    )
  }
}
