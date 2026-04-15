import { describe, it, expect } from 'vitest'
import {
  EvaluateAnswerLlmSchema,
  TurnRouterLlmSchema,
  FeedbackLlmSchema,
  FusionLlmSchema,
} from '@interview/validators/interview'

// ─── G.2 — Zod LLM response schemas ────────────────────────────────────
//
// These tests lock the permissiveness contract: we REJECT structural
// drift (wrong types) but TOLERATE unknown/extra fields and missing
// optional fields. Matches the route-side behavior: a failure is
// logged and we fall back, but a benign addition does not reject.

describe('EvaluateAnswerLlmSchema', () => {
  it('accepts a full happy-path payload', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 80,
      structure: 75,
      specificity: 70,
      ownership: 85,
      jdAlignment: 78,
      primaryGap: 'specificity',
      primaryStrength: 'ownership',
      answerSummary: 'Led team of 8 to reduce churn 20% at X',
      shouldProbe: false,
      probeType: null,
      probeTarget: null,
      isPivot: false,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a minimal payload with only some dimensions', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 60,
      structure: 55,
    })
    expect(result.success).toBe(true)
  })

  it('tolerates unknown fields via passthrough', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 80,
      unknownFutureField: 'something',
      nested: { anotherField: 123 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects wrong type on a known dimension', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 'not-a-number',
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong type on probeType enum', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 80,
      probeType: 'not-a-valid-enum',
    })
    expect(result.success).toBe(false)
  })

  it('accepts null probeType and probeTarget', () => {
    const result = EvaluateAnswerLlmSchema.safeParse({
      relevance: 80,
      probeType: null,
      probeTarget: null,
    })
    expect(result.success).toBe(true)
  })
})

describe('TurnRouterLlmSchema', () => {
  it('accepts a full happy-path payload', () => {
    const result = TurnRouterLlmSchema.safeParse({
      nextAction: 'probe',
      probeQuestion: 'Can you say more about that?',
      style: 'curious',
      isNonsensical: false,
      isPivot: false,
    })
    expect(result.success).toBe(true)
  })

  it('accepts "advance" with no probeQuestion', () => {
    const result = TurnRouterLlmSchema.safeParse({
      nextAction: 'advance',
      style: 'neutral',
      isNonsensical: false,
      isPivot: false,
    })
    expect(result.success).toBe(true)
  })

  it('accepts interruptResolution variant', () => {
    const result = TurnRouterLlmSchema.safeParse({
      nextAction: 'advance',
      interruptResolution: 'abort_and_pivot',
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown nextAction value', () => {
    const result = TurnRouterLlmSchema.safeParse({
      nextAction: 'unknown',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing nextAction entirely', () => {
    const result = TurnRouterLlmSchema.safeParse({
      style: 'curious',
    })
    expect(result.success).toBe(false)
  })

  it('tolerates unknown fields via passthrough', () => {
    const result = TurnRouterLlmSchema.safeParse({
      nextAction: 'probe',
      futureField: true,
    })
    expect(result.success).toBe(true)
  })
})

describe('FeedbackLlmSchema', () => {
  it('accepts a full happy-path payload', () => {
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 72,
      pass_probability: 'Medium',
      confidence_level: 'High',
      dimensions: {
        answer_quality: {
          score: 70,
          strengths: ['Clear structure'],
          weaknesses: ['Lacks metrics'],
        },
        communication: {
          score: 75,
          wpm: 140,
          filler_rate: 0.03,
          pause_score: 70,
          rambling_index: 0.2,
        },
        engagement_signals: {
          score: 72,
          engagement_score: 70,
          confidence_trend: 'stable',
          energy_consistency: 0.7,
          composure_under_pressure: 65,
        },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a truncated payload with missing dimensions', () => {
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 60,
    })
    expect(result.success).toBe(true)
  })

  it('accepts Claude variant pass_probability ("Medium-High")', () => {
    // Schema is permissive for variant strings; route normalizes later.
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 72,
      pass_probability: 'Medium-High',
    })
    expect(result.success).toBe(true)
  })

  it('rejects overall_score that is not a number', () => {
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 'seventy-two',
    })
    expect(result.success).toBe(false)
  })

  it('accepts ideal_answers with variant shape via passthrough', () => {
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 70,
      ideal_answers: [
        { questionIndex: 3, strongAnswer: 'X', keyElements: ['a', 'b'], extraField: 'tolerated' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('tolerates unknown top-level fields', () => {
    const result = FeedbackLlmSchema.safeParse({
      overall_score: 65,
      experimental_field: { anything: true },
    })
    expect(result.success).toBe(true)
  })
})

describe('FusionLlmSchema', () => {
  it('accepts a full happy-path payload', () => {
    const result = FusionLlmSchema.safeParse({
      timeline: [
        {
          startSec: 0,
          endSec: 30,
          type: 'strength',
          signal: 'fused',
          title: 'Strong opener',
          description: 'Clear, confident intro',
          severity: 'positive',
          questionIndex: 0,
        },
      ],
      fusionSummary: {
        overallBodyLanguageScore: 72,
        eyeContactScore: 68,
        confidenceProgression: 'Confidence rose through Q3.',
        topMoments: [0],
        improvementMoments: [],
        coachingTips: ['Tip 1', 'Tip 2', 'Tip 3'],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts topMoments as timeline objects (not indices)', () => {
    const result = FusionLlmSchema.safeParse({
      timeline: [],
      fusionSummary: {
        topMoments: [
          {
            startSec: 0,
            endSec: 10,
            type: 'strength',
            signal: 'fused',
            title: 'Moment',
            description: 'desc',
          },
        ],
        improvementMoments: [],
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing timeline field', () => {
    const result = FusionLlmSchema.safeParse({
      fusionSummary: { topMoments: [], improvementMoments: [] },
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing fusionSummary field', () => {
    const result = FusionLlmSchema.safeParse({
      timeline: [],
    })
    expect(result.success).toBe(false)
  })

  it('tolerates unknown fusionSummary fields', () => {
    const result = FusionLlmSchema.safeParse({
      timeline: [],
      fusionSummary: {
        overallBodyLanguageScore: 70,
        newExperimentalField: 'tolerated',
      },
    })
    expect(result.success).toBe(true)
  })
})
