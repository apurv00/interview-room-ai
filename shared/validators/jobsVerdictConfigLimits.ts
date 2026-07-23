export const JOBS_VERDICT_CONFIG_LIMITS = {
  dailyVerdictCap: { min: 0, max: 25_000, step: 1, integer: true },
  dailyBudgetUsd: { min: 0, max: 100, step: 0.01, integer: false },
  monthlyBudgetUsd: { min: 0, max: 3_100, step: 0.01, integer: false },
  perCompanyDailyCap: { min: 0, max: 1_000, step: 1, integer: true },
  perSourceDailyCap: { min: 0, max: 25_000, step: 1, integer: true },
  inputUsdPerMTok: { min: 0.01, max: 100, step: 0.01, integer: false },
  outputUsdPerMTok: { min: 0.01, max: 100, step: 0.01, integer: false },
} as const

export type JobsVerdictNumericKey = keyof typeof JOBS_VERDICT_CONFIG_LIMITS
export const JOBS_VERDICT_CONFIG_SWITCH_KEYS = [
  'collectionEnabled',
  'enforceEnabled',
  'rankingEnabled',
] as const
export type JobsVerdictSwitchKey = (typeof JOBS_VERDICT_CONFIG_SWITCH_KEYS)[number]

export function jobsVerdictConfigNumericIssueOf(
  input: Partial<Record<JobsVerdictNumericKey, unknown>>,
): string | null {
  for (const key of Object.keys(JOBS_VERDICT_CONFIG_LIMITS) as JobsVerdictNumericKey[]) {
    const value = input[key]
    const limit = JOBS_VERDICT_CONFIG_LIMITS[key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (limit.integer && !Number.isSafeInteger(value)) ||
      value < limit.min ||
      value > limit.max
    ) {
      const kind = limit.integer ? 'integer' : 'finite number'
      return `${key} must be a ${kind} from ${limit.min} to ${limit.max}`
    }
  }
  return null
}

export function jobsVerdictConfigIssueOf(
  input: Partial<Record<JobsVerdictNumericKey | JobsVerdictSwitchKey, unknown>>,
): string | null {
  for (const key of JOBS_VERDICT_CONFIG_SWITCH_KEYS) {
    if (typeof input[key] !== 'boolean') return `${key} must be boolean`
  }
  if (input.rankingEnabled !== false) {
    return 'rankingEnabled is unavailable until the post-GA ranking gate'
  }
  if (input.enforceEnabled === true && input.collectionEnabled !== true) {
    return 'collectionEnabled must be true when enforceEnabled is true'
  }

  const numericIssue = jobsVerdictConfigNumericIssueOf(input)
  if (numericIssue) return numericIssue

  const values = input as Record<JobsVerdictNumericKey, number>
  if (
    values.dailyVerdictCap > 0 &&
    values.perCompanyDailyCap > values.dailyVerdictCap
  ) {
    return 'perCompanyDailyCap must not exceed a nonzero dailyVerdictCap'
  }
  if (
    values.dailyVerdictCap > 0 &&
    values.perSourceDailyCap > values.dailyVerdictCap
  ) {
    return 'perSourceDailyCap must not exceed a nonzero dailyVerdictCap'
  }
  if (
    values.dailyBudgetUsd > 0 &&
    values.dailyBudgetUsd > values.monthlyBudgetUsd
  ) {
    return 'dailyBudgetUsd must not exceed monthlyBudgetUsd when the daily budget is nonzero'
  }
  return null
}
