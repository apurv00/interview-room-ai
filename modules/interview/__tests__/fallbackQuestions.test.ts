import { describe, it, expect } from 'vitest'
import { getNextFallbackQuestion, FALLBACK_QUESTIONS } from '@interview/config/fallbackQuestions'

const generic = new Set<string>(FALLBACK_QUESTIONS)

describe('getNextFallbackQuestion (domain-aware)', () => {
  it('returns a role-appropriate (non-generic) question for a known domain', () => {
    // backend → programming category pool; finance → business pool
    const backendQ = getNextFallbackQuestion(new Set<string>(), 'backend')
    const financeQ = getNextFallbackQuestion(new Set<string>(), 'finance')
    expect(generic.has(backendQ)).toBe(false)
    expect(generic.has(financeQ)).toBe(false)
    expect(backendQ).not.toBe(financeQ)
  })

  it('falls back to the universal pool for an unknown or missing domain', () => {
    expect(generic.has(getNextFallbackQuestion(new Set<string>()))).toBe(true)
    expect(generic.has(getNextFallbackQuestion(new Set<string>(), 'not-a-real-domain'))).toBe(true)
    // 'general' has no category pool → universal
    expect(generic.has(getNextFallbackQuestion(new Set<string>(), 'general'))).toBe(true)
  })

  it('does not repeat a question until the domain pool is exhausted, then resets', () => {
    const used = new Set<string>()
    const seen = new Set<string>()
    // Pull 5 (programming pool size) — all should be distinct
    for (let i = 0; i < 5; i++) seen.add(getNextFallbackQuestion(used, 'mobile'))
    expect(seen.size).toBe(5)
    // Next call resets and reuses the pool (no throw, returns a valid question)
    const next = getNextFallbackQuestion(used, 'mobile')
    expect(typeof next).toBe('string')
    expect(next.length).toBeGreaterThan(0)
  })

  it('stays correct when the pool changes mid-session with a shared Set', () => {
    // Repro of the QA-flagged case: first failure fires before config.role hydrates
    // (universal pool), then a later call resolves a domain pool with the SAME Set.
    const used = new Set<string>()
    const q1 = getNextFallbackQuestion(used) // universal (no domain yet)
    const q2 = getNextFallbackQuestion(used, 'backend') // programming pool
    expect(generic.has(q1)).toBe(true)
    // q2 must be a real programming question, not skipped/misindexed by q1's position.
    expect(generic.has(q2)).toBe(false)
    expect(q2.length).toBeGreaterThan(0)
  })
})
