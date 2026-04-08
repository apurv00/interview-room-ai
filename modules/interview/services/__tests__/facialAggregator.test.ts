import { describe, it, expect } from 'vitest'
import { aggregateFacialData } from '../facialAggregator'
import type { FacialFrame } from '@shared/types/multimodal'

describe('facialAggregator', () => {
  const makeFrames = (overrides: Partial<FacialFrame>[] = []): FacialFrame[] =>
    overrides.map((o, i) => ({
      ts: i * 0.2,
      gazeX: 0,
      gazeY: 0,
      headPoseYaw: 0,
      headPosePitch: 0,
      expression: 'neutral',
      eyeContactScore: 0.8,
      ...o,
    }))

  it('returns empty array when no frames', () => {
    expect(aggregateFacialData([], [0], 60)).toEqual([])
  })

  it('returns empty array when no question boundaries', () => {
    const frames = makeFrames([{ ts: 1 }])
    expect(aggregateFacialData(frames, [], 60)).toEqual([])
  })

  it('computes average eye contact', () => {
    const frames = makeFrames([
      { ts: 1, eyeContactScore: 0.9 },
      { ts: 2, eyeContactScore: 0.7 },
      { ts: 3, eyeContactScore: 0.8 },
    ])
    const result = aggregateFacialData(frames, [0], 10)

    expect(result).toHaveLength(1)
    expect(result[0].avgEyeContact).toBeCloseTo(0.8, 1)
  })

  it('finds dominant expression', () => {
    const frames = makeFrames([
      { ts: 1, expression: 'smile' },
      { ts: 2, expression: 'smile' },
      { ts: 3, expression: 'neutral' },
      { ts: 4, expression: 'smile' },
    ])
    const result = aggregateFacialData(frames, [0], 10)

    expect(result[0].dominantExpression).toBe('smile')
  })

  it('measures head stability', () => {
    // Very stable head position
    const stableFrames = makeFrames([
      { ts: 1, headPoseYaw: 1, headPosePitch: 0 },
      { ts: 2, headPoseYaw: 2, headPosePitch: 1 },
      { ts: 3, headPoseYaw: 1, headPosePitch: 0 },
    ])
    const stableResult = aggregateFacialData(stableFrames, [0], 10)

    // Very unstable head position
    const unstableFrames = makeFrames([
      { ts: 1, headPoseYaw: -30, headPosePitch: -20 },
      { ts: 2, headPoseYaw: 30, headPosePitch: 20 },
      { ts: 3, headPoseYaw: -30, headPosePitch: -20 },
    ])
    const unstableResult = aggregateFacialData(unstableFrames, [0], 10)

    expect(stableResult[0].headStability).toBeGreaterThan(unstableResult[0].headStability)
  })

  it('splits into multiple question windows', () => {
    const frames = makeFrames([
      { ts: 1, eyeContactScore: 0.9 },
      { ts: 2, eyeContactScore: 0.9 },
      { ts: 11, eyeContactScore: 0.3 },
      { ts: 12, eyeContactScore: 0.3 },
    ])
    const result = aggregateFacialData(frames, [0, 10], 20)

    expect(result).toHaveLength(2)
    expect(result[0].avgEyeContact).toBeCloseTo(0.9, 1)
    expect(result[1].avgEyeContact).toBeCloseTo(0.3, 1)
  })

  it('classifies gesture level', () => {
    // Expressive: large head movements
    const frames = makeFrames([
      { ts: 1, headPoseYaw: -10, headPosePitch: 0 },
      { ts: 1.2, headPoseYaw: 10, headPosePitch: 5 },
      { ts: 1.4, headPoseYaw: -10, headPosePitch: -5 },
      { ts: 1.6, headPoseYaw: 10, headPosePitch: 5 },
    ])
    const result = aggregateFacialData(frames, [0], 5)
    expect(['moderate', 'expressive']).toContain(result[0].gestureLevel)
  })

  describe('fixed-width window mode', () => {
    it('emits uniform N-second buckets when windowSec is set', () => {
      const frames = makeFrames([
        { ts: 0.5 },
        { ts: 1.5 },
        { ts: 2.5 },
        { ts: 3.5 },
      ])
      const result = aggregateFacialData(frames, [], 4, { windowSec: 1 })
      expect(result).toHaveLength(4)
      expect(result[0].startSec).toBe(0)
      expect(result[0].endSec).toBe(1)
      expect(result[3].startSec).toBe(3)
      expect(result[3].endSec).toBe(4)
      expect(result.every((s) => s.questionIndex === undefined)).toBe(true)
    })

    it('falls back to per-question mode when windowSec is not set', () => {
      const frames = makeFrames([{ ts: 1 }, { ts: 2 }])
      const result = aggregateFacialData(frames, [0, 5], 10)
      expect(result).toHaveLength(2)
      expect(result[0].questionIndex).toBe(0)
      expect(result[1].questionIndex).toBe(1)
    })

    it('returns empty for fixed-width mode with no duration', () => {
      const frames = makeFrames([{ ts: 1 }])
      expect(aggregateFacialData(frames, [], 0, { windowSec: 1 })).toEqual([])
    })

    it('returns empty for per-question mode with no boundaries', () => {
      const frames = makeFrames([{ ts: 1 }])
      expect(aggregateFacialData(frames, [], 10)).toEqual([])
    })

    it('handles frames landing in empty windows', () => {
      const frames = makeFrames([{ ts: 0.5 }, { ts: 2.5 }])
      const result = aggregateFacialData(frames, [], 3, { windowSec: 1 })
      expect(result).toHaveLength(3)
      // Middle window has no frames — synthesizes a neutral empty segment
      expect(result[1].avgEyeContact).toBe(0)
      expect(result[1].dominantExpression).toBe('neutral')
    })
  })

  describe('blendshape stats', () => {
    it('emits mean and max blendshapes when includeBlendshapeStats is set', () => {
      const frames = makeFrames([
        { ts: 0.5, blendshapes: { mouthSmileLeft: 0.2, mouthSmileRight: 0.3 } },
        { ts: 0.8, blendshapes: { mouthSmileLeft: 0.4, mouthSmileRight: 0.5 } },
      ])
      const result = aggregateFacialData(frames, [], 1, {
        windowSec: 1,
        includeBlendshapeStats: true,
      })
      expect(result).toHaveLength(1)
      expect(result[0].meanBlendshapes).toEqual({
        mouthSmileLeft: 0.3,
        mouthSmileRight: 0.4,
      })
      expect(result[0].maxBlendshapes).toEqual({
        mouthSmileLeft: 0.4,
        mouthSmileRight: 0.5,
      })
    })

    it('omits blendshape stats when flag not set', () => {
      const frames = makeFrames([
        { ts: 0.5, blendshapes: { mouthSmileLeft: 0.2 } },
      ])
      const result = aggregateFacialData(frames, [], 1, { windowSec: 1 })
      expect(result[0].meanBlendshapes).toBeUndefined()
      expect(result[0].maxBlendshapes).toBeUndefined()
    })

    it('omits blendshape stats when frames lack blendshapes', () => {
      const frames = makeFrames([{ ts: 0.5 }, { ts: 0.8 }])
      const result = aggregateFacialData(frames, [], 1, {
        windowSec: 1,
        includeBlendshapeStats: true,
      })
      expect(result[0].meanBlendshapes).toBeUndefined()
      expect(result[0].maxBlendshapes).toBeUndefined()
    })

    it('handles mixed frames (some with, some without blendshapes)', () => {
      const frames = makeFrames([
        { ts: 0.2, blendshapes: { mouthSmileLeft: 0.6 } },
        { ts: 0.5 }, // no blendshapes
        { ts: 0.8, blendshapes: { mouthSmileLeft: 0.4 } },
      ])
      const result = aggregateFacialData(frames, [], 1, {
        windowSec: 1,
        includeBlendshapeStats: true,
      })
      // Mean over the 2 frames that had blendshapes: (0.6 + 0.4) / 2 = 0.5
      expect(result[0].meanBlendshapes?.mouthSmileLeft).toBeCloseTo(0.5, 3)
      expect(result[0].maxBlendshapes?.mouthSmileLeft).toBeCloseTo(0.6, 3)
    })
  })
})
