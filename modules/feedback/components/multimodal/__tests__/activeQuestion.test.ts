import { describe, it, expect } from 'vitest'
import { findActiveQuestionIndex } from '../activeQuestion'

/**
 * Regression test for Codex P2 on PR #370:
 *
 *   Initializing `last` to `0` makes `activeQuestionIndex` default to Q1
 *   even when playback is still before the first question marker (e.g.,
 *   intro/silence at the start of the recording). That causes the UI to
 *   show an incorrect active question chip, asked-question text, and
 *   highlight band until the first marker is actually reached; initialize
 *   with -1 so no question is active before `offsetSeconds` is crossed.
 */
describe('findActiveQuestionIndex (Codex P2 #370)', () => {
  const QUESTIONS = [
    { offsetSeconds: 30 },
    { offsetSeconds: 90 },
    { offsetSeconds: 180 },
  ]

  it('returns -1 when no question markers exist', () => {
    expect(findActiveQuestionIndex([], 50)).toBe(-1)
  })

  it('returns -1 during pre-Q1 intro/silence (regression — was incorrectly returning 0)', () => {
    expect(findActiveQuestionIndex(QUESTIONS, 0)).toBe(-1)
    expect(findActiveQuestionIndex(QUESTIONS, 15)).toBe(-1)
    expect(findActiveQuestionIndex(QUESTIONS, 29.9)).toBe(-1)
  })

  it('returns 0 exactly at the Q1 boundary (inclusive)', () => {
    expect(findActiveQuestionIndex(QUESTIONS, 30)).toBe(0)
  })

  it('returns the largest-indexed marker whose offsetSeconds <= currentTime', () => {
    expect(findActiveQuestionIndex(QUESTIONS, 31)).toBe(0)
    expect(findActiveQuestionIndex(QUESTIONS, 89.9)).toBe(0)
    expect(findActiveQuestionIndex(QUESTIONS, 90)).toBe(1)
    expect(findActiveQuestionIndex(QUESTIONS, 179.9)).toBe(1)
    expect(findActiveQuestionIndex(QUESTIONS, 180)).toBe(2)
    expect(findActiveQuestionIndex(QUESTIONS, 500)).toBe(2)
  })

  it('handles a single-question session', () => {
    expect(findActiveQuestionIndex([{ offsetSeconds: 10 }], 0)).toBe(-1)
    expect(findActiveQuestionIndex([{ offsetSeconds: 10 }], 10)).toBe(0)
    expect(findActiveQuestionIndex([{ offsetSeconds: 10 }], 999)).toBe(0)
  })
})
