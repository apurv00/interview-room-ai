import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getXpSummary } from '@learn/services/xpService'
import { redis } from '@shared/redis'

export const dynamic = 'force-dynamic'

const XP_CACHE_TTL = 60 // 60 seconds

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Try Redis cache first
    const cacheKey = `xp:${session.user.id}`
    try {
      const cached = await redis.get(cacheKey)
      if (cached) return NextResponse.json(JSON.parse(cached))
    } catch {
      // Fall through to DB
    }

    const summary = await getXpSummary(session.user.id)

    // Cache for 60 seconds
    try {
      await redis.setex(cacheKey, XP_CACHE_TTL, JSON.stringify(summary))
    } catch {
      // Non-critical
    }

    return NextResponse.json(summary)
  } catch {
    return NextResponse.json(
      { xp: 0, level: 1, title: 'Novice', xpToNextLevel: 100, xpThisWeek: 0, xpForCurrentLevel: 0, xpForNextLevel: 100 },
    )
  }
}
