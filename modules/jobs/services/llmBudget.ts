import { logger } from '@shared/logger'

/**
 * LLM verdict budget breaker (INGESTION §4.5): Redis daily/monthly meters +
 * per-companyKey and per-source daily caps (salted-repost storm defense).
 *
 * FAIL-CLOSED by design — the repost counter fails OPEN because losing a
 * demotion signal is tolerable, but a spend guard that fails open is an
 * unbounded bill. Denied ≡ verdict stays `pending` ≡ rules-only serving,
 * which is always safe (ruling #15 floor).
 *
 * Tiers over the daily verdict cap: ≥80% → `softening` (sweeper halves its
 * batch); ≥95% → deny (pending-only). Same idiom as the §4.6 quota meters.
 */

export interface VerdictBudgetCaps {
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
}

export interface BudgetDecision {
  allowed: boolean
  /** ≥80% of the daily verdict or spend cap — callers halve batch sizes. */
  softening: boolean
  reason?: string
}

interface RedisLike {
  get(key: string): Promise<string | null>
  incr(key: string): Promise<number>
  incrbyfloat(key: string, n: number): Promise<string>
  expire(key: string, seconds: number): Promise<number>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
}

const DAY_TTL = 2 * 24 * 3600
const MONTH_TTL = 35 * 24 * 3600
const DEGRADED_KEY = 'jobs:llm:degraded'
export const DEGRADED_TTL_SECONDS = 30 * 60

function dayStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '')
}
function monthStamp(now: Date): string {
  return now.toISOString().slice(0, 7).replace(/-/g, '')
}

export function makeLlmBudget(redis: RedisLike, caps: VerdictBudgetCaps) {
  return {
    /** Pre-call gate. Reads only — spend is recorded post-call via record(). */
    async check(companyKey: string, sourceId: string, now = new Date()): Promise<BudgetDecision> {
      try {
        // A zeroed cap means PAUSE, not "disable this limb": 0/0 is NaN and
        // NaN comparisons are silently false — the fail-open the module
        // contract forbids (adversarial review of Wave 2.3).
        if (caps.dailyVerdictCap <= 0 || caps.dailyBudgetUsd <= 0 || caps.monthlyBudgetUsd <= 0) {
          return { allowed: false, softening: true, reason: 'caps-zeroed' }
        }
        const d = dayStamp(now)
        const [dayCount, dayCost, monthCost, companyCount, sourceCount, degraded] = await Promise.all([
          redis.get(`jobs:llm:verdicts:day:${d}`),
          redis.get(`jobs:llm:cost:day:${d}`),
          redis.get(`jobs:llm:cost:month:${monthStamp(now)}`),
          redis.get(`jobs:llm:verdicts:company:${companyKey}:${d}`),
          redis.get(`jobs:llm:verdicts:source:${sourceId}:${d}`),
          redis.get(DEGRADED_KEY),
        ])
        if (degraded) return { allowed: false, softening: true, reason: 'circuit-breaker-degraded' }
        const nDay = Number(dayCount ?? 0)
        const usdDay = Number(dayCost ?? 0)
        const usdMonth = Number(monthCost ?? 0)
        if (Number(companyCount ?? 0) >= caps.perCompanyDailyCap) return { allowed: false, softening: false, reason: 'per-company-cap' }
        if (Number(sourceCount ?? 0) >= caps.perSourceDailyCap) return { allowed: false, softening: false, reason: 'per-source-cap' }
        if (usdMonth >= caps.monthlyBudgetUsd) return { allowed: false, softening: true, reason: 'monthly-budget' }
        const dayFraction = Math.max(nDay / caps.dailyVerdictCap, usdDay / caps.dailyBudgetUsd)
        if (dayFraction >= 0.95) return { allowed: false, softening: true, reason: 'daily-95pct' }
        return { allowed: true, softening: dayFraction >= 0.8 }
      } catch (err) {
        logger.warn({ err }, 'jobs llm budget check failed — failing CLOSED (verdicts stay pending)')
        return { allowed: false, softening: true, reason: 'budget-unavailable' }
      }
    },

    /** Post-call spend record. incr + first-hit expire; errors logged, never thrown. */
    async record(companyKey: string, sourceId: string, costUsd: number, now = new Date()): Promise<void> {
      try {
        const d = dayStamp(now)
        const bumps: Array<[string, number]> = [
          [`jobs:llm:verdicts:day:${d}`, DAY_TTL],
          [`jobs:llm:verdicts:company:${companyKey}:${d}`, DAY_TTL],
          [`jobs:llm:verdicts:source:${sourceId}:${d}`, DAY_TTL],
        ]
        for (const [key, ttl] of bumps) {
          const n = await redis.incr(key)
          if (n === 1) await redis.expire(key, ttl)
        }
        const costDayKey = `jobs:llm:cost:day:${d}`
        const costMonthKey = `jobs:llm:cost:month:${monthStamp(now)}`
        const dayTotal = await redis.incrbyfloat(costDayKey, costUsd)
        if (Number(dayTotal) === costUsd) await redis.expire(costDayKey, DAY_TTL)
        const monthTotal = await redis.incrbyfloat(costMonthKey, costUsd)
        if (Number(monthTotal) === costUsd) await redis.expire(costMonthKey, MONTH_TTL)
      } catch (err) {
        logger.warn({ err }, 'jobs llm budget record failed')
      }
    },

    /** Circuit breaker: ≥6 consecutive evaluator failures trips 30min of pending-only. */
    async setDegraded(): Promise<void> {
      try {
        await redis.set(DEGRADED_KEY, '1', 'EX', DEGRADED_TTL_SECONDS)
      } catch (err) {
        logger.warn({ err }, 'jobs llm degraded flag set failed')
      }
    },

    async isDegraded(): Promise<boolean> {
      try {
        return (await redis.get(DEGRADED_KEY)) != null
      } catch {
        return true // unreadable breaker state = assume degraded (fail-closed)
      }
    },
  }
}

export type LlmBudget = ReturnType<typeof makeLlmBudget>
