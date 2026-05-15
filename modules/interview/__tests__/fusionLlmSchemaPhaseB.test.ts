import { describe, it, expect } from 'vitest'
import { FusionLlmSchema } from '../validators/interview'

/**
 * Phase B (2026-05-16): the FusionLlmSchema gains an optional coachingTipsRich
 * field. These tests pin the Zod contract: the new field is accepted when
 * present, ignored when absent, rejected when malformed.
 */
describe('FusionLlmSchema — Phase B coachingTipsRich field', () => {
  const validBase = {
    timeline: [],
    fusionSummary: {
      overallBodyLanguageScore: 75,
      eyeContactScore: 80,
      confidenceProgression: 'stable',
      topMoments: [],
      improvementMoments: [],
      coachingTips: ['Slow down.', 'Smile more.'],
    },
  }

  it('accepts the legacy shape (no coachingTipsRich)', () => {
    const result = FusionLlmSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })

  it('accepts a well-formed coachingTipsRich array', () => {
    const result = FusionLlmSchema.safeParse({
      ...validBase,
      fusionSummary: {
        ...validBase.fusionSummary,
        coachingTipsRich: [
          { text: 'Slow down.', category: 'Communication', questionIndex: 2 },
          { text: 'Smile more.', category: 'Behavior' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty coachingTipsRich array (model emitted field but populated nothing)', () => {
    const result = FusionLlmSchema.safeParse({
      ...validBase,
      fusionSummary: { ...validBase.fusionSummary, coachingTipsRich: [] },
    })
    expect(result.success).toBe(true)
  })

  it('rejects coachingTipsRich entries with an invalid category', () => {
    const result = FusionLlmSchema.safeParse({
      ...validBase,
      fusionSummary: {
        ...validBase.fusionSummary,
        coachingTipsRich: [{ text: 'Slow down.', category: 'NotARealCategory' }],
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects coachingTipsRich entries with a negative questionIndex', () => {
    const result = FusionLlmSchema.safeParse({
      ...validBase,
      fusionSummary: {
        ...validBase.fusionSummary,
        coachingTipsRich: [{ text: 'Slow down.', category: 'Communication', questionIndex: -1 }],
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects coachingTipsRich entries missing required text', () => {
    const result = FusionLlmSchema.safeParse({
      ...validBase,
      fusionSummary: {
        ...validBase.fusionSummary,
        coachingTipsRich: [{ category: 'Communication' }],
      },
    })
    expect(result.success).toBe(false)
  })
})
