import { createHash } from 'node:crypto'
import { logger } from '@shared/logger'
import type { JobSourceRequestBudget } from '../config/sourceCatalog'

export type SourceRequestRejection = 'quota-exhausted' | 'quota-unavailable'
export type SourceRequestDecision = void | { allowed: false; reason: SourceRequestRejection }

interface RedisQuotaClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
}

const CLAIM_SCRIPT = `
local function safeCounter(key)
  local raw = redis.call('GET', key)
  if not raw then return 0 end
  local value = tonumber(raw)
  if not value or value < 0 or value % 1 ~= 0 then return nil end
  return value
end
local run = safeCounter(KEYS[1])
local day = safeCounter(KEYS[2])
local month = safeCounter(KEYS[3])
if run == nil or day == nil or month == nil then
  return {-1, 0, 0, 0}
end
local runCap = tonumber(ARGV[1])
local dayCap = tonumber(ARGV[2])
local monthCap = tonumber(ARGV[3])
if run >= runCap or day >= dayCap or month >= monthCap then
  return {0, run, day, month}
end
run = redis.call('INCR', KEYS[1])
day = redis.call('INCR', KEYS[2])
month = redis.call('INCR', KEYS[3])
if run == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
if day == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
if month == 1 then redis.call('EXPIRE', KEYS[3], tonumber(ARGV[6])) end
return {1, run, day, month}
`

const RUN_TTL_SECONDS = 35 * 24 * 60 * 60
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60
const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60

/** Redis Cluster executes a multi-key Lua script only when every key shares
 * one hash slot. Hashing the source id also prevents caller-controlled braces
 * from changing the cluster tag. */
function sourceQuotaNamespace(sourceId: string): string {
  const sourceHash = createHash('sha256').update(sourceId).digest('hex')
  return `jobs:ingest:requests:{source-${sourceHash}}`
}

function windowKeys(sourceId: string, now: Date): { day: string; month: string } {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const month = now.toISOString().slice(0, 7).replace(/-/g, '')
  return {
    day: `${sourceQuotaNamespace(sourceId)}:day:${day}`,
    month: `${sourceQuotaNamespace(sourceId)}:month:${month}`,
  }
}

function runKey(sourceId: string, runId: string): string {
  const stableRunHash = createHash('sha256').update(runId).digest('hex')
  return `${sourceQuotaNamespace(sourceId)}:run:${stableRunHash}`
}

function parseCounter(value: string | null): number | null {
  const parsed = Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function makeSourceQuotaGuard(
  redis: RedisQuotaClient,
  sourceId: string,
  runId: string,
  budget: JobSourceRequestBudget,
) {
  let claimedAttempts = 0
  return {
    async beforeRequest(now = new Date()): Promise<SourceRequestDecision> {
      if (
        budget.perRunRequestCap <= 0 || budget.dailyRequestCap <= 0 ||
        budget.monthlyRequestCap <= 0 || !runId.trim()
      ) return { allowed: false, reason: 'quota-exhausted' }
      const quotaKeys = windowKeys(sourceId, now)
      try {
        const raw = await redis.eval(
          CLAIM_SCRIPT, 3, runKey(sourceId, runId), quotaKeys.day, quotaKeys.month,
          budget.perRunRequestCap, budget.dailyRequestCap, budget.monthlyRequestCap,
          RUN_TTL_SECONDS, DAY_TTL_SECONDS, MONTH_TTL_SECONDS,
        )
        const values = Array.isArray(raw) ? raw.map(Number) : []
        if (values[0] === -1) return { allowed: false, reason: 'quota-unavailable' }
        if (values[0] !== 1) return { allowed: false, reason: 'quota-exhausted' }
        claimedAttempts++
        return undefined
      } catch (error) {
        logger.warn({ error, sourceId }, 'jobs source request quota unavailable — failing closed')
        return { allowed: false, reason: 'quota-unavailable' }
      }
    },
    attempts: () => claimedAttempts,
  }
}

export async function readSourceQuotaUsage(
  redis: RedisQuotaClient,
  sourceId: string,
  now = new Date(),
): Promise<{ usedToday: number; usedThisMonth: number } | null> {
  const quotaKeys = windowKeys(sourceId, now)
  try {
    const [day, month] = await Promise.all([redis.get(quotaKeys.day), redis.get(quotaKeys.month)])
    const usedToday = parseCounter(day)
    const usedThisMonth = parseCounter(month)
    return usedToday == null || usedThisMonth == null ? null : { usedToday, usedThisMonth }
  } catch {
    return null
  }
}

/** Durable usage for one stable Inngest event/operation. Unlike the guard's
 * invocation-local convenience counter, this survives worker retries. */
export async function readSourceRunQuotaUsage(
  redis: RedisQuotaClient,
  sourceId: string,
  runId: string,
): Promise<number | null> {
  if (!runId.trim()) return null
  try {
    return parseCounter(await redis.get(runKey(sourceId, runId)))
  } catch {
    return null
  }
}
