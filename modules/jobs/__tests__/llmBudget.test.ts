import { describe, it, expect, vi } from 'vitest'

vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))

import { makeLlmBudget, DEGRADED_TTL_SECONDS } from '../services/llmBudget'

const CAPS = { dailyVerdictCap: 100, dailyBudgetUsd: 2.5, monthlyBudgetUsd: 75, perCompanyDailyCap: 25, perSourceDailyCap: 500 }

function fakeRedis(store: Map<string, string> = new Map()) {
  return {
    store,
    expires: new Map<string, number>(),
    async get(key: string) { return store.get(key) ?? null },
    async incr(key: string) { const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); return n },
    async incrbyfloat(key: string, n: number) { const v = Number(store.get(key) ?? 0) + n; store.set(key, String(v)); return String(v) },
    async expire(key: string, seconds: number) { this.expires.set(key, seconds); return 1 },
    async set(key: string, value: string, _mode: 'EX', seconds: number) { store.set(key, value); this.expires.set(key, seconds); return 'OK' },
  }
}

const NOW = new Date('2026-07-14T06:00:00Z')
const DAY = '20260714'

describe('llmBudget (§4.5 breaker — FAIL-CLOSED)', () => {
  it('under all caps → allowed, no softening', async () => {
    const b = makeLlmBudget(fakeRedis(), CAPS)
    expect(await b.check('acme', 'jsearch', NOW)).toEqual({ allowed: true, softening: false })
  })

  it('≥80% of the daily cap softens; ≥95% denies (pending-only)', async () => {
    const r = fakeRedis(new Map([[`jobs:llm:verdicts:day:${DAY}`, '80']]))
    expect((await makeLlmBudget(r, CAPS).check('acme', 'jsearch', NOW)).softening).toBe(true)
    r.store.set(`jobs:llm:verdicts:day:${DAY}`, '95')
    const denied = await makeLlmBudget(r, CAPS).check('acme', 'jsearch', NOW)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('daily-95pct')
  })

  it('daily SPEND trips the same tiers as the verdict count', async () => {
    const r = fakeRedis(new Map([[`jobs:llm:cost:day:${DAY}`, '2.4']]))
    const d = await makeLlmBudget(r, CAPS).check('acme', 'jsearch', NOW)
    expect(d.allowed).toBe(false) // 2.4/2.5 = 96%
  })

  it('per-company and per-source daily caps deny (salted-repost storm defense)', async () => {
    const r = fakeRedis(new Map([[`jobs:llm:verdicts:company:acme:${DAY}`, '25']]))
    expect((await makeLlmBudget(r, CAPS).check('acme', 'jsearch', NOW)).reason).toBe('per-company-cap')
    const r2 = fakeRedis(new Map([[`jobs:llm:verdicts:source:jsearch:${DAY}`, '500']]))
    expect((await makeLlmBudget(r2, CAPS).check('acme', 'jsearch', NOW)).reason).toBe('per-source-cap')
  })

  it('monthly budget cap denies', async () => {
    const r = fakeRedis(new Map([['jobs:llm:cost:month:202607', '75']]))
    expect((await makeLlmBudget(r, CAPS).check('acme', 'jsearch', NOW)).reason).toBe('monthly-budget')
  })

  it('Redis down = FAIL-CLOSED (denied), never fail-open spend', async () => {
    const broken = { ...fakeRedis(), get: () => Promise.reject(new Error('conn refused')) }
    const d = await makeLlmBudget(broken as never, CAPS).check('acme', 'jsearch', NOW)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('budget-unavailable')
  })

  it('record: incr + first-hit-expire only; cost accumulates as float', async () => {
    const r = fakeRedis()
    const b = makeLlmBudget(r, CAPS)
    await b.record('acme', 'jsearch', 0.003, NOW)
    await b.record('acme', 'jsearch', 0.002, NOW)
    expect(r.store.get(`jobs:llm:verdicts:day:${DAY}`)).toBe('2')
    expect(Number(r.store.get(`jobs:llm:cost:day:${DAY}`))).toBeCloseTo(0.005)
    expect(r.expires.get(`jobs:llm:verdicts:day:${DAY}`)).toBeDefined() // set once, on first hit
  })

  it('a zeroed cap means PAUSE — denied, never NaN-fails-open', async () => {
    for (const zeroed of [{ dailyVerdictCap: 0 }, { dailyBudgetUsd: 0 }, { monthlyBudgetUsd: 0 }]) {
      const d = await makeLlmBudget(fakeRedis(), { ...CAPS, ...zeroed }).check('acme', 'jsearch', NOW)
      expect(d.allowed).toBe(false)
      expect(d.reason).toBe('caps-zeroed')
    }
  })

  it('circuit breaker: setDegraded blocks checks and isDegraded reports it (30min TTL)', async () => {
    const r = fakeRedis()
    const b = makeLlmBudget(r, CAPS)
    await b.setDegraded()
    expect(r.expires.get('jobs:llm:degraded')).toBe(DEGRADED_TTL_SECONDS)
    expect(await b.isDegraded()).toBe(true)
    expect((await b.check('acme', 'jsearch', NOW)).reason).toBe('circuit-breaker-degraded')
  })
})
