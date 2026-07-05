import { describe, it, expect } from 'vitest'
import { classifyExpression, EXPRESSION_THRESHOLDS } from '../useFacialLandmarks'

/**
 * classifyExpression maps summed L+R MediaPipe blendshapes to a coarse class.
 * These assert the retuned thresholds discriminate real expressions instead of
 * collapsing everything to neutral. NOTE: the thresholds themselves still need a
 * real-camera calibration pass (see AI_ANALYSIS.md §8) — this only locks the
 * classification LOGIC and guards against a regression back to neutral-only.
 */
describe('classifyExpression', () => {
  const bs = (m: Record<string, number>) => m

  it('returns neutral for a blank / resting face', () => {
    expect(classifyExpression(bs({}))).toBe('neutral')
  })

  it('detects a modest smile that the old 0.4 threshold missed', () => {
    // 0.15 + 0.15 = 0.30 > smile threshold (0.25) but < the old 0.4.
    expect(EXPRESSION_THRESHOLDS.smile).toBeLessThan(0.4)
    expect(classifyExpression(bs({ mouthSmileLeft: 0.15, mouthSmileRight: 0.15 }))).toBe('smile')
  })

  it('detects a frown', () => {
    expect(classifyExpression(bs({ mouthFrownLeft: 0.12, mouthFrownRight: 0.12 }))).toBe('frown')
  })

  it('detects surprise (brow up + eyes wide together)', () => {
    expect(
      classifyExpression(bs({ browOuterUpLeft: 0.2, browOuterUpRight: 0.2, eyeWideLeft: 0.15, eyeWideRight: 0.15 })),
    ).toBe('surprise')
  })

  it('detects focus (brow down) when there is no stronger mouth signal', () => {
    expect(classifyExpression(bs({ browDownLeft: 0.15, browDownRight: 0.15 }))).toBe('focused')
  })

  it('prioritizes a smile over a concurrent brow-down', () => {
    expect(
      classifyExpression(bs({ mouthSmileLeft: 0.2, mouthSmileRight: 0.2, browDownLeft: 0.2, browDownRight: 0.2 })),
    ).toBe('smile')
  })

  it('keeps sub-threshold micro-movements as neutral', () => {
    expect(classifyExpression(bs({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05, browDownLeft: 0.05 }))).toBe('neutral')
  })
})
