/**
 * Work Item G.8 — Claude-vs-formula overall_score blend.
 *
 * Validates `computeBlendedOverallScore` and `resolveBlendWeights`
 * (modules/interview/services/eval/overallScore.ts) as pure,
 * deterministic functions. Integration through the route (flag-on
 * vs flag-off) is covered in a separate file so this suite stays
 * focused on the math.
 *
 * Agreement zone (|Δ| ≤ threshold): default 0.6 Claude / 0.4 formula.
 * Disagreement zone (|Δ| > threshold): safety clamp → 0.3 / 0.7.
 * Missing Claude value: formula returned as-is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  computeBlendedOverallScore,
  resolveBlendWeights,
  DEFAULT_BLEND_WEIGHTS,
} from '@interview/services/eval/overallScore'

describe('G.8 — computeBlendedOverallScore', () => {
  describe('agreement zone', () => {
    it('uses 0.6/0.4 weights when Claude and formula agree closely', () => {
      // Claude=80, formula=70, Δ=10 (within default threshold 20)
      const r = computeBlendedOverallScore(80, 70)
      // 0.6*80 + 0.4*70 = 48 + 28 = 76
      expect(r.blended).toBe(76)
      expect(r.mode).toBe('agreement')
      expect(r.delta).toBe(10)
      expect(r.claudeClamped).toBe(80)
    })

    it('produces formula value when exactly equal to Claude', () => {
      const r = computeBlendedOverallScore(65, 65)
      expect(r.blended).toBe(65)
      expect(r.mode).toBe('agreement')
      expect(r.delta).toBe(0)
    })

    it('exits the compressed mid-band when Claude judges high', () => {
      // Regression scenario: formula stuck at ~70 (mean-of-means),
      // Claude sees strong narrative at 88. Δ=18 within threshold.
      const r = computeBlendedOverallScore(88, 70)
      // 0.6*88 + 0.4*70 = 52.8 + 28 = 80.8 → 81
      expect(r.blended).toBe(81)
      expect(r.mode).toBe('agreement')
    })

    it('exits mid-band downward when Claude judges low', () => {
      // Formula=65 (mean inflated by a couple of high dim scores),
      // Claude sees a pivot in Q3 and returns 50. Δ=15 within threshold.
      const r = computeBlendedOverallScore(50, 65)
      // 0.6*50 + 0.4*65 = 30 + 26 = 56
      expect(r.blended).toBe(56)
      expect(r.mode).toBe('agreement')
    })
  })

  describe('disagreement zone (safety clamp)', () => {
    it('pulls toward formula when Claude awards wildly higher', () => {
      // Claude=92, formula=58, Δ=34 > 20 → disagreement mode.
      const r = computeBlendedOverallScore(92, 58)
      // 0.3*92 + 0.7*58 = 27.6 + 40.6 = 68.2 → 68
      expect(r.blended).toBe(68)
      expect(r.mode).toBe('disagreement')
      expect(r.delta).toBe(34)
    })

    it('pulls toward formula when Claude awards wildly lower', () => {
      // Claude=30, formula=70, Δ=-40 > 20 → disagreement.
      const r = computeBlendedOverallScore(30, 70)
      // 0.3*30 + 0.7*70 = 9 + 49 = 58
      expect(r.blended).toBe(58)
      expect(r.mode).toBe('disagreement')
    })

    it('engages at exactly threshold+1', () => {
      // threshold = 20 → Δ=21 engages disagreement mode
      const r = computeBlendedOverallScore(91, 70)
      expect(r.mode).toBe('disagreement')
    })

    it('does NOT engage at exactly threshold', () => {
      // Δ=20 is within (inclusive) agreement.
      const r = computeBlendedOverallScore(90, 70)
      expect(r.mode).toBe('agreement')
    })
  })

  describe('missing / invalid Claude value', () => {
    it('returns formula when Claude value is undefined', () => {
      const r = computeBlendedOverallScore(undefined, 68)
      expect(r.blended).toBe(68)
      expect(r.mode).toBe('formula-only')
      expect(r.claudeClamped).toBeUndefined()
    })

    it('returns formula when Claude value is null', () => {
      const r = computeBlendedOverallScore(null, 72)
      expect(r.blended).toBe(72)
      expect(r.mode).toBe('formula-only')
    })

    it('returns formula when Claude value is NaN', () => {
      const r = computeBlendedOverallScore(Number.NaN, 55)
      expect(r.blended).toBe(55)
      expect(r.mode).toBe('formula-only')
    })

    it('returns formula when Claude value is Infinity', () => {
      const r = computeBlendedOverallScore(Number.POSITIVE_INFINITY, 55)
      expect(r.blended).toBe(55)
      expect(r.mode).toBe('formula-only')
    })
  })

  describe('clamping', () => {
    it('clamps Claude > 100 to 100', () => {
      const r = computeBlendedOverallScore(150, 70)
      // Claude clamps to 100, Δ=30 → disagreement zone.
      // 0.3*100 + 0.7*70 = 30 + 49 = 79
      expect(r.blended).toBe(79)
      expect(r.claudeClamped).toBe(100)
      expect(r.mode).toBe('disagreement')
    })

    it('clamps Claude < 0 to 0', () => {
      const r = computeBlendedOverallScore(-20, 40)
      // Claude clamps to 0, Δ=-40 → disagreement.
      // 0.3*0 + 0.7*40 = 28
      expect(r.blended).toBe(28)
      expect(r.claudeClamped).toBe(0)
      expect(r.mode).toBe('disagreement')
    })

    it('clamps formula < 0 and > 100 too', () => {
      const r = computeBlendedOverallScore(70, -10)
      // formula clamps to 0, Claude=70, Δ=70 → disagreement.
      // 0.3*70 + 0.7*0 = 21
      expect(r.blended).toBe(21)
    })
  })

  describe('custom weights', () => {
    it('respects a 100/0 claude-only split', () => {
      const r = computeBlendedOverallScore(80, 50, {
        claudeWeight: 1.0,
        formulaWeight: 0.0,
        disagreementThreshold: 20,
        disagreementClaudeWeight: 1.0,
        disagreementFormulaWeight: 0.0,
      })
      expect(r.blended).toBe(80)
    })

    it('respects a 0/100 formula-only split (pre-G.8 behavior)', () => {
      const r = computeBlendedOverallScore(80, 60, {
        claudeWeight: 0.0,
        formulaWeight: 1.0,
        disagreementThreshold: 20,
        disagreementClaudeWeight: 0.0,
        disagreementFormulaWeight: 1.0,
      })
      // Regardless of zone, formula dominates.
      expect(r.blended).toBe(60)
    })

    it('respects a higher disagreement threshold', () => {
      // With threshold=40, a Δ of 30 stays in agreement zone.
      const r = computeBlendedOverallScore(92, 62, {
        ...DEFAULT_BLEND_WEIGHTS,
        disagreementThreshold: 40,
      })
      expect(r.mode).toBe('agreement')
    })
  })
})

describe('G.8 — resolveBlendWeights env overrides', () => {
  const original = { ...process.env }
  beforeEach(() => {
    // Reset to a clean slate each test
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SCORING_V2_')) delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SCORING_V2_')) delete process.env[k]
    }
    for (const [k, v] of Object.entries(original)) {
      if (k.startsWith('SCORING_V2_')) process.env[k] = v as string
    }
  })

  it('returns DEFAULT_BLEND_WEIGHTS when no env vars set', () => {
    const w = resolveBlendWeights()
    expect(w).toEqual(DEFAULT_BLEND_WEIGHTS)
  })

  it('overrides claudeWeight from SCORING_V2_CLAUDE_WEIGHT', () => {
    process.env.SCORING_V2_CLAUDE_WEIGHT = '0.75'
    const w = resolveBlendWeights()
    expect(w.claudeWeight).toBe(0.75)
    expect(w.formulaWeight).toBe(DEFAULT_BLEND_WEIGHTS.formulaWeight) // unchanged
  })

  it('overrides disagreementThreshold', () => {
    process.env.SCORING_V2_DISAGREEMENT_THRESHOLD = '30'
    const w = resolveBlendWeights()
    expect(w.disagreementThreshold).toBe(30)
  })

  it('ignores non-numeric env values (falls back to default)', () => {
    process.env.SCORING_V2_CLAUDE_WEIGHT = 'not-a-number'
    const w = resolveBlendWeights()
    expect(w.claudeWeight).toBe(DEFAULT_BLEND_WEIGHTS.claudeWeight)
  })

  it('ignores negative env values (falls back to default)', () => {
    process.env.SCORING_V2_CLAUDE_WEIGHT = '-0.5'
    const w = resolveBlendWeights()
    expect(w.claudeWeight).toBe(DEFAULT_BLEND_WEIGHTS.claudeWeight)
  })
})
