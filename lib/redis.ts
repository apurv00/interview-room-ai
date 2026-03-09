import Redis from 'ioredis'
import { logger } from './logger'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const globalWithRedis = global as typeof globalThis & {
  redis?: Redis
}

function createRedisClient(): Redis {
  if (globalWithRedis.redis) return globalWithRedis.redis

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null
      return Math.min(times * 200, 2000)
    },
    lazyConnect: true,
  })

  client.on('error', (err) => {
    logger.error({ err }, 'Redis connection error')
  })

  client.on('connect', () => {
    logger.info('Redis connected')
  })

  if (process.env.NODE_ENV === 'development') {
    globalWithRedis.redis = client
  }

  return client
}

export const redis = createRedisClient()
