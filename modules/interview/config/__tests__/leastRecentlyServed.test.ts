/**
 * PR "served-problem ledger" — last-resort selection.
 *
 * When the pool is exhausted for a user AND the AI generator failed, the old
 * behavior re-selected with NO exclusions (uniform-random repeat). The new
 * selectLeastRecentlyServed / selectLeastRecentlyServedDesign pick the problem
 * the user saw LONGEST ago instead — deterministic, and never fresher than
 * necessary. servedIds arrive most-recent-first (the history-route order), so
 * the highest index is the oldest; ids absent from the list rank oldest of all.
 */
import { describe, it, expect } from 'vitest'
import {
  CODING_PROBLEMS,
  selectLeastRecentlyServed,
} from '../codingProblems'
import {
  DESIGN_PROBLEMS,
  selectLeastRecentlyServedDesign,
} from '../designProblems'

describe('selectLeastRecentlyServed (coding)', () => {
  // '3-6' targets medium first; backend has a real medium pool.
  const backendMediumIds = CODING_PROBLEMS
    .filter((p) => p.difficulty === 'medium' && p.applicableDomains.includes('backend'))
    .map((p) => p.id)

  it('returns a problem even when every candidate has been served', () => {
    const picked = selectLeastRecentlyServed('backend', '3-6', backendMediumIds)
    expect(picked).not.toBeNull()
    expect(backendMediumIds).toContain(picked!.id)
  })

  it('picks the problem served longest ago (highest index in most-recent-first list)', () => {
    const picked = selectLeastRecentlyServed('backend', '3-6', backendMediumIds)
    expect(picked!.id).toBe(backendMediumIds[backendMediumIds.length - 1])
  })

  it('prefers a never-served problem over any served one', () => {
    const [holdout, ...served] = backendMediumIds
    const picked = selectLeastRecentlyServed('backend', '3-6', served)
    expect(picked!.id).toBe(holdout)
  })

  it('is deterministic for identical inputs', () => {
    const a = selectLeastRecentlyServed('backend', '3-6', backendMediumIds)
    const b = selectLeastRecentlyServed('backend', '3-6', backendMediumIds)
    expect(a!.id).toBe(b!.id)
  })

  it('respects the difficulty override', () => {
    const picked = selectLeastRecentlyServed('backend', '7+', [], 'easy')
    expect(picked).not.toBeNull()
    expect(['easy', 'medium']).toContain(picked!.difficulty)
  })

  it('borrows the fallback domain pool for roles without native problems', () => {
    // ml-engineer has no native pool; PROBLEM_POOL_FALLBACK borrows data-science.
    const picked = selectLeastRecentlyServed('ml-engineer', '3-6', [])
    expect(picked).not.toBeNull()
    expect(picked!.applicableDomains).toContain('data-science')
  })
})

describe('selectLeastRecentlyServedDesign', () => {
  // '3-6' targets medium+hard; backend is tagged on the whole design pool.
  const backendIds = DESIGN_PROBLEMS
    .filter((p) => ['medium', 'hard'].includes(p.difficulty) && p.applicableDomains.includes('backend'))
    .map((p) => p.id)

  it('returns a problem even when every candidate has been served', () => {
    const picked = selectLeastRecentlyServedDesign('backend', '3-6', backendIds)
    expect(picked).not.toBeNull()
    expect(backendIds).toContain(picked!.id)
  })

  it('picks the problem served longest ago', () => {
    const picked = selectLeastRecentlyServedDesign('backend', '3-6', backendIds)
    expect(picked!.id).toBe(backendIds[backendIds.length - 1])
  })

  it('prefers a never-served problem over any served one', () => {
    const [holdout, ...served] = backendIds
    const picked = selectLeastRecentlyServedDesign('backend', '3-6', served)
    expect(picked!.id).toBe(holdout)
  })

  it('drops the domain filter when the domain has no pool at the target difficulty', () => {
    // data-analyst is not tagged in the static design pool — the domain filter
    // yields nothing and the difficulty-only pool must still return a problem.
    const picked = selectLeastRecentlyServedDesign('data-analyst', '0-2', [])
    expect(picked).not.toBeNull()
    expect(['easy', 'medium']).toContain(picked!.difficulty)
  })

  it('is deterministic for identical inputs', () => {
    const a = selectLeastRecentlyServedDesign('backend', '3-6', backendIds)
    const b = selectLeastRecentlyServedDesign('backend', '3-6', backendIds)
    expect(a!.id).toBe(b!.id)
  })
})
