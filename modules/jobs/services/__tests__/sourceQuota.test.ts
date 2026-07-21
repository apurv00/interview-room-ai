import { describe, expect, it } from 'vitest'
import { makeSourceQuotaGuard, readSourceQuotaUsage } from '../sourceQuota'

class FakeQuotaRedis {
  readonly counts = new Map<string, number | string>()
  readonly evalKeys: string[][] = []
  unavailable = false

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<number[]> {
    if (this.unavailable) throw new Error('redis unavailable')
    const keys = args.slice(0, numberOfKeys).map(String)
    this.evalKeys.push(keys)
    const [runCap, dayCap, monthCap] = args.slice(numberOfKeys, numberOfKeys + 3).map(Number)
    const rawCounters = keys.map((key) => this.counts.get(key) ?? 0)
    const [run, day, month] = rawCounters.map(Number)
    if ([run, day, month].some((value) => !Number.isSafeInteger(value) || value < 0)) {
      return [-1, 0, 0, 0]
    }
    if (run >= runCap || day >= dayCap || month >= monthCap) return [0, run, day, month]
    const next = [run + 1, day + 1, month + 1]
    keys.forEach((key, index) => this.counts.set(key, next[index]))
    return [1, ...next]
  }

  async get(key: string): Promise<string | null> {
    if (this.unavailable) throw new Error('redis unavailable')
    const value = this.counts.get(key)
    return value == null ? null : String(value)
  }
}

const budget = {
  perRunRequestCap: 2,
  dailyRequestCap: 3,
  monthlyRequestCap: 4,
}

describe('source physical-request quota', () => {
  it('keeps the per-run cap across worker retries and shares day/month counters', async () => {
    const redis = new FakeQuotaRedis()
    const firstAttempt = makeSourceQuotaGuard(redis, 'jsearch', 'event-1', budget)
    expect(await firstAttempt.beforeRequest(new Date('2026-07-22T01:00:00Z'))).toBeUndefined()
    expect(await firstAttempt.beforeRequest(new Date('2026-07-22T01:01:00Z'))).toBeUndefined()

    // A new handler instance for the same Inngest event cannot reset the cap.
    const replay = makeSourceQuotaGuard(redis, 'jsearch', 'event-1', budget)
    expect(await replay.beforeRequest(new Date('2026-07-22T01:02:00Z'))).toEqual({
      allowed: false,
      reason: 'quota-exhausted',
    })

    const nextRun = makeSourceQuotaGuard(redis, 'jsearch', 'event-2', budget)
    expect(await nextRun.beforeRequest(new Date('2026-07-22T02:00:00Z'))).toBeUndefined()
    expect(await nextRun.beforeRequest(new Date('2026-07-22T02:01:00Z'))).toEqual({
      allowed: false,
      reason: 'quota-exhausted',
    })
    expect(await readSourceQuotaUsage(redis, 'jsearch', new Date('2026-07-22T03:00:00Z'))).toEqual({
      usedToday: 3,
      usedThisMonth: 3,
    })
  })

  it('places run, day, and month keys in one injection-safe Redis Cluster slot', async () => {
    const redis = new FakeQuotaRedis()
    const guard = makeSourceQuotaGuard(redis, 'source}{attacker', 'event-1', budget)

    expect(await guard.beforeRequest(new Date('2026-07-22T01:00:00Z'))).toBeUndefined()

    const keys = redis.evalKeys[0]
    const tags = keys.map((key) => key.match(/\{([^}]+)\}/)?.[1])
    expect(new Set(tags).size).toBe(1)
    expect(tags[0]).toMatch(/^source-[a-f0-9]{64}$/)
    expect(keys.every((key) => !key.includes('attacker'))).toBe(true)
  })

  it('fails closed when Redis cannot atomically claim a request', async () => {
    const redis = new FakeQuotaRedis()
    redis.unavailable = true
    const guard = makeSourceQuotaGuard(redis, 'jsearch', 'event-1', budget)
    expect(await guard.beforeRequest()).toEqual({ allowed: false, reason: 'quota-unavailable' })
    expect(guard.attempts()).toBe(0)
    expect(await readSourceQuotaUsage(redis, 'jsearch')).toBeNull()
  })

  it('fails closed for an empty run identity or zero budget', async () => {
    const redis = new FakeQuotaRedis()
    const noIdentity = makeSourceQuotaGuard(redis, 'jsearch', '', budget)
    expect(await noIdentity.beforeRequest()).toEqual({ allowed: false, reason: 'quota-exhausted' })
    const noBudget = makeSourceQuotaGuard(redis, 'jsearch', 'event-1', {
      perRunRequestCap: 0,
      dailyRequestCap: 0,
      monthlyRequestCap: 0,
    })
    expect(await noBudget.beforeRequest()).toEqual({ allowed: false, reason: 'quota-exhausted' })
  })

  it('treats malformed Redis counters as unavailable instead of zero', async () => {
    const redis = new FakeQuotaRedis()
    redis.get = async () => 'NaN'
    expect(await readSourceQuotaUsage(redis, 'jsearch')).toBeNull()
  })

  it.each([
    ['negative', -100],
    ['malformed', 'not-a-number'],
    ['fractional', '1.5'],
  ])('rejects a %s persisted counter before incrementing any quota key', async (_name, corrupted) => {
    const redis = new FakeQuotaRedis()
    const guard = makeSourceQuotaGuard(redis, 'jsearch', 'event-corrupt', budget)
    expect(await guard.beforeRequest(new Date('2026-07-22T01:00:00Z'))).toBeUndefined()
    const keys = redis.evalKeys[0]
    redis.counts.set(keys[1], corrupted)
    const before = keys.map((key) => redis.counts.get(key))

    expect(await guard.beforeRequest(new Date('2026-07-22T01:01:00Z'))).toEqual({
      allowed: false,
      reason: 'quota-unavailable',
    })
    expect(keys.map((key) => redis.counts.get(key))).toEqual(before)
  })
})
