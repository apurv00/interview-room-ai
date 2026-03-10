import { describe, it, expect } from 'vitest'
import { deriveCoachingTip } from '../coachingTips'
import type { AnswerEvaluation } from '../types'

function makeEval(overrides: Partial<AnswerEvaluation> = {}): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'Test question',
    answer: 'Test answer',
    relevance: 60,
    structure: 60,
    specificity: 60,
    ownership: 60,
    needsFollowUp: false,
    flags: [],
    ...overrides,
  }
}

describe('deriveCoachingTip', () => {
  // ── Positive tip (avg >= 70) ──
  it('returns positive tip when all scores >= 70', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 80, structure: 75, specificity: 70, ownership: 90 }))
    expect(tip).toBe('Great answer! Keep that energy.')
  })

  it('returns positive tip when avg is exactly 70', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 70, structure: 70, specificity: 70, ownership: 70 }))
    expect(tip).toBe('Great answer! Keep that energy.')
  })

  // ── Critical tip (avg < 40) ──
  it('returns critical tip when avg < 40', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 20, structure: 30, specificity: 25, ownership: 35 }))
    expect(tip).toContain('Take a moment')
  })

  it('returns critical tip when avg is exactly 39', () => {
    // avg = (39 + 39 + 39 + 39) / 4 = 39
    const tip = deriveCoachingTip(makeEval({ relevance: 39, structure: 39, specificity: 39, ownership: 39 }))
    expect(tip).toContain('Take a moment')
  })

  // ── Boundary: avg = 69 (below 70, above 40) ──
  it('returns dimension-specific tip when avg = 69', () => {
    // avg = (69 + 69 + 69 + 69) / 4 = 69
    const tip = deriveCoachingTip(makeEval({ relevance: 69, structure: 69, specificity: 69, ownership: 69 }))
    // All equal → tie-breaking → structure wins (first in priority order)
    expect(tip).toContain('Situation, Task, Action, Result')
  })

  // ── Weakest dimension identification ──
  it('identifies structure as weakest', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 65, structure: 40, specificity: 60, ownership: 60 }))
    expect(tip).toContain('Situation, Task, Action, Result')
  })

  it('identifies specificity as weakest', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 65, structure: 60, specificity: 40, ownership: 60 }))
    expect(tip).toContain('numbers or metrics')
  })

  it('identifies ownership as weakest', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 65, structure: 60, specificity: 60, ownership: 40 }))
    expect(tip).toContain("'I'")
  })

  it('identifies relevance as weakest', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 40, structure: 60, specificity: 60, ownership: 60 }))
    expect(tip).toContain('Focus directly')
  })

  // ── Tie-breaking (structure > specificity > ownership > relevance) ──
  it('breaks tie in favor of structure when all equal', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 50, structure: 50, specificity: 50, ownership: 50 }))
    expect(tip).toContain('Situation, Task, Action, Result')
  })

  it('breaks tie: specificity wins over ownership when structure is higher', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: 60, structure: 60, specificity: 45, ownership: 45 }))
    expect(tip).toContain('numbers or metrics')
  })

  // ── NaN / invalid scores ──
  it('returns generic tip for NaN relevance', () => {
    const tip = deriveCoachingTip(makeEval({ relevance: NaN }))
    expect(tip).toBe('Keep going — you are doing well.')
  })

  it('returns generic tip for undefined score', () => {
    const tip = deriveCoachingTip(makeEval({ structure: undefined as unknown as number }))
    expect(tip).toBe('Keep going — you are doing well.')
  })

  it('returns generic tip for negative score', () => {
    const tip = deriveCoachingTip(makeEval({ specificity: -10 }))
    expect(tip).toBe('Keep going — you are doing well.')
  })

  it('returns generic tip for score > 100', () => {
    const tip = deriveCoachingTip(makeEval({ ownership: 150 }))
    expect(tip).toBe('Keep going — you are doing well.')
  })
})
