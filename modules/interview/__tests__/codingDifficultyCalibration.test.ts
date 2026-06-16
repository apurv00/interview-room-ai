import { describe, it, expect } from 'vitest'
import { resolveCodingTimeBudget, resolveCodingDifficulty } from '@interview/config/codingProblems'

/**
 * Phase A (candidate feedback 2026-06-16): difficulty must be calibrated to the
 * time actually available, not experience alone — a 10-min interview must not
 * hand a senior a 25-min "hard" problem.
 */
describe('resolveCodingTimeBudget', () => {
  it('subtracts overhead and divides across problems, floored at 4', () => {
    expect(resolveCodingTimeBudget(10, 1)).toBe(6) // (10-4)/1
    expect(resolveCodingTimeBudget(20, 1)).toBe(16) // (20-4)/1
    expect(resolveCodingTimeBudget(30, 2)).toBe(13) // (30-4)/2
    expect(resolveCodingTimeBudget(5, 1)).toBe(4) // floored
  })
})

describe('resolveCodingDifficulty', () => {
  it('caps a senior in a short slot to an easy/quick problem', () => {
    // 10-min interview → budget 6 → easy, even for a 7+ candidate.
    expect(resolveCodingDifficulty('7+', resolveCodingTimeBudget(10, 1))).toBe('easy')
  })

  it('lets a senior take a hard problem only when time allows', () => {
    expect(resolveCodingDifficulty('7+', 25)).toBe('hard')
    expect(resolveCodingDifficulty('7+', 16)).toBe('medium') // time-capped
  })

  it('never over-challenges a junior regardless of time', () => {
    expect(resolveCodingDifficulty('0-2', 30)).toBe('easy')
  })

  it('picks the EASIER of experience and time caps', () => {
    expect(resolveCodingDifficulty('3-6', 6)).toBe('easy') // time caps the mid candidate
    expect(resolveCodingDifficulty('3-6', 16)).toBe('medium')
  })
})
