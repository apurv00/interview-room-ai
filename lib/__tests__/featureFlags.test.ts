import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('featureFlags', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns default values when no env vars set', async () => {
    const { isFeatureEnabled } = await import('@/lib/featureFlags')
    expect(isFeatureEnabled('personalization_engine')).toBe(true)
    expect(isFeatureEnabled('benchmark_harness')).toBe(false)
  })

  it('respects env var overrides with "true"', async () => {
    process.env.FEATURE_FLAG_BENCHMARK_HARNESS = 'true'
    const { isFeatureEnabled } = await import('@/lib/featureFlags')
    expect(isFeatureEnabled('benchmark_harness')).toBe(true)
  })

  it('respects env var overrides with "1"', async () => {
    process.env.FEATURE_FLAG_BENCHMARK_HARNESS = '1'
    const { isFeatureEnabled } = await import('@/lib/featureFlags')
    expect(isFeatureEnabled('benchmark_harness')).toBe(true)
  })

  it('respects env var disabling with "false"', async () => {
    process.env.FEATURE_FLAG_PERSONALIZATION_ENGINE = 'false'
    const { isFeatureEnabled } = await import('@/lib/featureFlags')
    expect(isFeatureEnabled('personalization_engine')).toBe(false)
  })

  it('respects env var disabling with "0"', async () => {
    process.env.FEATURE_FLAG_PERSONALIZATION_ENGINE = '0'
    const { isFeatureEnabled } = await import('@/lib/featureFlags')
    expect(isFeatureEnabled('personalization_engine')).toBe(false)
  })

  it('getEnabledFlags returns all flags', async () => {
    const { getEnabledFlags } = await import('@/lib/featureFlags')
    const flags = getEnabledFlags()
    expect(flags).toHaveProperty('personalization_engine')
    expect(flags).toHaveProperty('evaluation_engine_v2')
    expect(flags).toHaveProperty('pathway_planner')
    expect(flags).toHaveProperty('competency_tracking')
    expect(flags).toHaveProperty('weakness_clusters')
    expect(flags).toHaveProperty('session_summaries')
    expect(flags).toHaveProperty('question_bank_rag')
    expect(flags).toHaveProperty('company_patterns_rag')
    expect(flags).toHaveProperty('benchmark_harness')
    expect(flags).toHaveProperty('adaptive_difficulty')
    expect(flags).toHaveProperty('rubric_registry')
  })
})
