import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { UsageRecord } from '@shared/db/models/UsageRecord'

// ─── Configuration ──────────────────────────────────────────────────────────

/** 24 h — ensures the list is cleaned up even if the session never completes */
const BUFFER_TTL = 86400

const bufKey = (sessionId: string) => `usage:buf:${sessionId}`

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * JSON-serialisable usage record stored in the Redis buffer.
 * ObjectId fields (userId, organizationId, sessionId) are stored as hex
 * strings; Mongoose auto-casts them when `insertMany` is called.
 */
export interface UsageRecordData {
  userId: string
  organizationId?: string
  type: string
  sessionId?: string
  inputTokens: number
  outputTokens: number
  modelUsed: string
  costUsd: number
  durationMs: number
  success: boolean
  errorMessage?: string
}

// ─── Buffer Operations ──────────────────────────────────────────────────────

/**
 * Appends one serialised usage record to the Redis list for `sessionId` and
 * refreshes the 24-hour TTL. Throws on Redis error so callers can fall back
 * to a direct Mongo insert.
 */
export async function bufferUsage(sessionId: string, record: UsageRecordData): Promise<void> {
  const key = bufKey(sessionId)
  await redis.rpush(key, JSON.stringify(record))
  await redis.expire(key, BUFFER_TTL)
}

/**
 * Flushes all buffered usage records for a session into MongoDB via a single
 * `insertMany` call, then deletes the Redis key.
 *
 * - No-op when the buffer is empty.
 * - Failures are logged and swallowed — usage records are analytics data;
 *   losing them must never break the request path.
 *
 * Called from the PATCH /api/interviews/[id] handler when status='completed'.
 */
export async function flushUsageBuffer(sessionId: string): Promise<void> {
  const key = bufKey(sessionId)

  let raw: string[] = []
  try {
    raw = await redis.lrange(key, 0, -1)
    if (raw.length === 0) return
    // Delete key first so concurrent flushes don't double-insert.
    // If insertMany fails afterwards the records are lost, which is
    // acceptable — same risk profile as the existing fire-and-forget writes.
    await redis.del(key)
  } catch (err) {
    logger.warn({ err, sessionId }, 'flushUsageBuffer: redis read/del failed')
    return
  }

  try {
    await connectDB()
    const records = raw.map((r) => JSON.parse(r) as UsageRecordData)
    await UsageRecord.insertMany(records, { ordered: false })
    logger.debug({ sessionId, count: records.length }, 'Usage buffer flushed')
  } catch (err) {
    logger.warn({ err, sessionId }, 'flushUsageBuffer: insertMany failed — records may be lost')
  }
}
