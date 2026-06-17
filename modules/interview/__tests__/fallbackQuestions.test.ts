import { describe, it, expect } from 'vitest'
import { getNextFallbackQuestion, FALLBACK_QUESTIONS } from '@interview/config/fallbackQuestions'

const generic = new Set<string>(FALLBACK_QUESTIONS)

describe('getNextFallbackQuestion (domain-aware)', () => {
  it('returns a role-appropriate (non-generic) question for a known domain', () => {
    // backend → programming category pool; finance → business pool
    const backendQ = getNextFallbackQuestion(new Set(), 'backend')
    const financeQ = getNextFallbackQuestion(new Set(), 'finance')
    expect(generic.has(backendQ)).toBe(false)
    expect(generic.has(financeQ)).toBe(false)
    expect(backendQ).not.toBe(financeQ)
  })

  it('falls back to the universal pool for an unknown or missing domain', () => {
    expect(generic.has(getNextFallbackQuestion(new Set()))).toBe(true)
    expect(generic.has(getNextFallbackQuestion(new Set(), 'not-a-real-domain'))).toBe(true)
    // 'general' has no category pool → universal
    expect(generic.has(getNextFallbackQuestion(new Set(), 'general'))).toBe(true)
  })

  it('does not repeat a question until the domain pool is exhausted, then resets', () => {
    const used = new Set<number>()
    const seen = new Set<string>()
    // Pull 5 (programming pool size) — all should be distinct
    for (let i = 0; i < 5; i++) seen.add(getNextFallbackQuestion(used, 'mobile'))
    expect(seen.size).toBe(5)
    // Next call resets and reuses the pool (no throw, returns a valid question)
    const next = getNextFallbackQuestion(used, 'mobile')
    expect(typeof next).toBe('string')
    expect(next.length).toBeGreaterThan(0)
  })
})
