import { redis } from '@shared/redis'
import { aiLogger as logger } from '@shared/logger'

export async function invalidateUnnotifiedBadgesCache(userId: string): Promise<void> {
  try {
    await redis.del(`badges:unnotified:${userId}`)
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to invalidate unnotified badges cache')
  }
}
