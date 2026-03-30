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
})
