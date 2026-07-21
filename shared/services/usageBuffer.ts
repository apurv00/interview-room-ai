import { redis } from '@shared/redis'
import { logger } from '@shared/logger'
import { connectDB } from '@shared/db/connection'
import { UsageRecord } from '@shared/db/models/UsageRecord'
import {
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

// ─── Configuration ──────────────────────────────────────────────────────────

/** 24 h — ensures the list is cleaned up even if the session never completes */
const BUFFER_TTL = 86400
/** Longer than the seven-day stateless JWT lifetime. ObjectIds are never
 * reused, so this only seals in-flight Redis writers for a deleted identity. */
const ACCOUNT_DELETION_TOMBSTONE_TTL = 8 * 86400

const bufKey = (sessionId: string) => `usage:buf:${sessionId}`
const deletionKey = (userId: string) => `usage:account-deleting:${userId}`
const userBuffersKey = (userId: string) => `usage:user-buffers:${userId}`

const APPEND_IF_ACCOUNT_ACTIVE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[3], KEYS[1])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return 1
`

const TOMBSTONE_AND_DELETE_LUA = `
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
local indexed = redis.call('SMEMBERS', KEYS[2])
for _, bufferKey in ipairs(indexed) do
  redis.call('DEL', bufferKey)
end
for i = 3, #KEYS do
  redis.call('DEL', KEYS[i])
end
redis.call('DEL', KEYS[2])
return #indexed + #KEYS - 2
`

const CLEAN_INDEX_IF_BUFFER_EMPTY_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return redis.call('SREM', KEYS[2], KEYS[1])
end
return 0
`

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
export async function bufferUsage(sessionId: string, record: UsageRecordData): Promise<boolean> {
  const key = bufKey(sessionId)
  const accepted = await redis.eval(
    APPEND_IF_ACCOUNT_ACTIVE_LUA,
    3,
    key,
    deletionKey(record.userId),
    userBuffersKey(record.userId),
    JSON.stringify(record),
    BUFFER_TTL,
  )
  return Number(accepted) === 1
}

/** Establish the Redis half of the account-deletion fence and atomically
 * remove every usage buffer captured from the user's current sessions. */
export async function tombstoneAccountUsageBuffers(
  userId: string,
  sessionIds: string[],
): Promise<void> {
  // The user index covers every buffer committed by the current writer,
  // including a session that raced the Mongo session snapshot. Explicit
  // session keys additionally remove buffers created by the pre-index build.
  const keys = [
    deletionKey(userId),
    userBuffersKey(userId),
    ...Array.from(new Set(sessionIds.map(bufKey))),
  ]
  await redis.eval(
    TOMBSTONE_AND_DELETE_LUA,
    keys.length,
    ...keys,
    ACCOUNT_DELETION_TOMBSTONE_TTL,
  )
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
    const byUser = new Map<string, UsageRecordData[]>()
    for (const record of records) {
      const group = byUser.get(record.userId) ?? []
      group.push(record)
      byUser.set(record.userId, group)
    }
    // The index is a deletion aid, not canonical data. Remove the drained
    // key so a continuously active account cannot retain every historical
    // session member forever. Failure only leaves a harmless stale pointer;
    // the index TTL and account-deletion Lua remain bounded/safe.
    try {
      await Promise.all(
        Array.from(byUser.keys()).map((userId) =>
          redis.eval(
            CLEAN_INDEX_IF_BUFFER_EMPTY_LUA,
            2,
            key,
            userBuffersKey(userId),
          ),
        ),
      )
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'flushUsageBuffer: user index cleanup failed')
    }
    for (const [userId, userRecords] of Array.from(byUser.entries())) {
      try {
        await withActiveJobsAccountWrite(userId, (session) =>
          UsageRecord.insertMany(userRecords, { ordered: false, session }),
        )
      } catch (error) {
        if (!(error instanceof JobsAccountInactiveError)) throw error
      }
    }
    logger.debug({ sessionId, count: records.length }, 'Usage buffer flushed')
  } catch (err) {
    logger.warn({ err, sessionId }, 'flushUsageBuffer: insertMany failed — records may be lost')
  }
}
