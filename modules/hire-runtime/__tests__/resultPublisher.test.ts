import { describe, expect, it } from 'vitest'
import { buildRuntimeResult } from '../services/resultPublisher'

describe('isolated runtime result mapping', () => {
  it('suppresses fabricated dimensions from failed evaluations', () => {
    const result = buildRuntimeResult({
      _id: { toString: () => 'a'.repeat(24) },
      status: 'completed',
      completedAt: new Date('2026-08-10T00:00:00.000Z'),
      feedback: {
        overall_score: 75,
        pass_probability: 'High',
        confidence_level: 'Medium',
        dimensions: {
          answer_quality: { score: 76 },
          communication: { score: 74 },
        },
        red_flags: [],
        top_3_improvements: ['Use more metrics'],
      },
      evaluations: [
        {
          status: 'failed',
          questionIndex: 0,
          question: 'Tell me about a launch.',
          answer: 'Example answer',
          relevance: 60,
          structure: 55,
          specificity: 55,
          ownership: 60,
        },
      ],
    })
    expect(result.perQuestion?.[0]).toMatchObject({
      evaluationFailed: true,
      score: null,
      relevance: null,
      structure: null,
      specificity: null,
      ownership: null,
    })
  })

  it('maps all-zero engine sentinels to unscored, never AI score zero', () => {
    const result = buildRuntimeResult({
      _id: { toString: () => 'a'.repeat(24) },
      status: 'completed',
      feedback: {
        overall_score: 0,
        dimensions: {
          answer_quality: { score: 0 },
          communication: { score: 0 },
        },
        red_flags: ['Insufficient evidence'],
        top_3_improvements: [],
      },
    })
    expect(result).toMatchObject({
      overallScore: null,
      answerQualityScore: null,
      communicationScore: null,
      unscored: true,
    })
  })

  it('marks completion pending while feedback is not yet persisted', () => {
    const result = buildRuntimeResult({
      _id: { toString: () => 'a'.repeat(24) },
      status: 'completed',
      feedback: null,
      evaluations: [],
    })
    expect(result.pending).toBe(true)
    expect(result.overallScore).toBeNull()
  })
})
