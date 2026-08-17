import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ completion: vi.fn() }))
vi.mock('@shared/services/modelRouter', () => ({ completion: mocks.completion }))

import {
  buildHireMultimodalBaselineTimeline,
  runHireMultimodalFusion,
} from '../services/hireMultimodalFusionService'

const input = {
  durationMs: 10_000,
  prosodySegments: [{
    startSec: 0,
    endSec: 5,
    wpm: 145,
    fillerWords: [{ word: 'um', timestampSec: 2 }],
    pauseDurationSec: 0.7,
    confidenceMarker: 'medium' as const,
    questionIndex: 0,
  }],
  facialSegments: [{
    startSec: 0,
    endSec: 5,
    avgEyeContact: 0.8,
    headStability: 0.7,
    dominantExpression: 'focused',
    gestureLevel: 'moderate' as const,
    questionIndex: 0,
  }],
  contentSignals: [{
    questionIndex: 0,
    question: 'Tell me about a release.',
    score: 74,
    relevance: 80,
    structure: 70,
    specificity: 65,
    ownership: 75,
    jdAlignment: 78,
    flags: [],
  }],
}

describe('Hire recorded-interview fusion', () => {
  it('emits all deterministic audio, facial, and content facts without a hiring decision', () => {
    const timeline = buildHireMultimodalBaselineTimeline(input)
    expect(timeline.map((event) => event.signal)).toEqual(
      expect.arrayContaining(['audio', 'facial', 'content']),
    )
    expect(JSON.stringify(timeline)).not.toMatch(/recommend|hire|rank/i)
  })

  it('falls back to full derived timeline when the supplemental model is unavailable', async () => {
    mocks.completion.mockRejectedValueOnce(new Error('temporary provider error'))
    const report = await runHireMultimodalFusion(input)
    expect(report.timeline).toHaveLength(3)
    expect(report.summary.eyeContactScore).toBe(80)
    expect(report.summary.bodyLanguageScore).toBe(77)
    expect(report.summary.attentionMoments).toEqual(expect.any(Array))
  })

  it('forces visual metrics to null if no facial samples were captured', async () => {
    mocks.completion.mockRejectedValueOnce(new Error('temporary provider error'))
    const report = await runHireMultimodalFusion({ ...input, facialSegments: [] })
    expect(report.summary.bodyLanguageScore).toBeNull()
    expect(report.summary.eyeContactScore).toBeNull()
  })
})
