import { describe, it, expect } from 'vitest'
import { scoreBand, scoreTextClass } from '../ScoreBar'

// Locks the canonical score-band thresholds (75/55). These MUST match the hero
// band label, QuestionBreakdown, and ScoreSummaryHeader — the ring + bars used to
// drift at 70/50, painting the same number a different band than the label (#498).
describe('scoreBand', () => {
  it('bands at 75 (strong) and 55 (ok)', () => {
    expect(scoreBand(75)).toBe('strong')
    expect(scoreBand(74)).toBe('ok')
    expect(scoreBand(55)).toBe('ok')
    expect(scoreBand(54)).toBe('weak')
    expect(scoreBand(100)).toBe('strong')
    expect(scoreBand(0)).toBe('weak')
  })
})

describe('scoreTextClass', () => {
  it('paints the reported 72 as amber, not the old 70/50 green', () => {
    expect(scoreTextClass(72)).toBe('text-amber-600')
    expect(scoreTextClass(76)).toBe('text-emerald-600')
    expect(scoreTextClass(52)).toBe('text-red-500')
  })
})
