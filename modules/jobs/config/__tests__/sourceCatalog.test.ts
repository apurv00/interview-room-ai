import { describe, expect, it } from 'vitest'
import {
  effectiveSourceRequestBudget,
  jobSourceDefinition,
  sourceCatalogIdentityMatches,
  sourcePolicyHash,
} from '../sourceCatalog'

function jsearch(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'jsearch',
    kind: 'aggregator-api' as const,
    displayName: 'JSearch',
    requestBudget: { perRunRequestCap: 180, dailyRequestCap: 220, monthlyRequestCap: 5_000 },
    cadenceMinutes: 1_440,
    llmVerdictOptOut: false,
    ...overrides,
  }
}

describe('deploy-reviewed source authority', () => {
  it('rejects persisted budgets above any catalog ceiling instead of clamping or falling back', () => {
    expect(effectiveSourceRequestBudget(jsearch({
      requestBudget: { perRunRequestCap: 181, dailyRequestCap: 221, monthlyRequestCap: 5_001 },
    }))).toBeNull()
  })

  it('rejects missing/malformed budgets fail closed', () => {
    expect(effectiveSourceRequestBudget(jsearch({ requestBudget: undefined }))).toBeNull()
    expect(effectiveSourceRequestBudget(jsearch({
      requestBudget: { perRunRequestCap: 20, dailyRequestCap: 10, monthlyRequestCap: 100 },
    }))).toBeNull()
  })

  it('treats catalog company identity as immutable worker input', () => {
    const definition = jobSourceDefinition('gh:phonepe')!
    expect(sourceCatalogIdentityMatches({ ...definition, displayName: 'Relabelled Co' })).toBe(false)
    expect(sourceCatalogIdentityMatches(definition)).toBe(true)
  })

  it.each([
    { cadenceMinutes: 14 },
    { cadenceMinutes: 10_081 },
    { minIndiaPostings: -1 },
    { minIndiaPostings: 100_001 },
    { llmVerdictOptOut: 'false' },
    { notes: 'x'.repeat(2_001) },
  ])('rejects malformed mutable policy: %o', (override) => {
    expect(sourcePolicyHash(jsearch(override) as never)).toBeNull()
  })

  it('binds every mutable setting, including notes, into the authority hash', () => {
    const baseline = sourcePolicyHash(jsearch() as never)
    expect(baseline).toMatch(/^[a-f0-9]{64}$/)
    expect(sourcePolicyHash(jsearch({ notes: 'operator note' }) as never)).not.toBe(baseline)
    expect(sourcePolicyHash(jsearch({ llmVerdictOptOut: true }) as never)).not.toBe(baseline)
  })
})
