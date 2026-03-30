import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { getUnnotifiedBadges } from '@learn/services/badgeService'
import { redis } from '@shared/redis'
import { aiLogger as logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const CACHE_TTL_SECONDS = 60

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id
    const cacheKey = `badges:unnotified:${userId}`

    // Try Redis cache first
    try {
      const cached = await redis.get(cacheKey)
      if (cached !== null) {
        return NextResponse.json(JSON.parse(cached))
      }
    } catch (err) {
      logger.warn({ err }, 'Redis cache read failed for unnotified badges')
    }

    const badges = await getUnnotifiedBadges(userId)
    const response = { badges }

    // Cache the result
    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL_SECONDS)
    } catch (err) {
      logger.warn({ err }, 'Redis cache write failed for unnotified badges')
    }

    return NextResponse.json(response)
  } catch {
    return NextResponse.json({ badges: [] })
  }
}
