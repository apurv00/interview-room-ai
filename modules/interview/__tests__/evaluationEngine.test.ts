import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@shared/db/models', () => ({
  EvaluationRubric: {
    findOne: vi.fn().mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }),
  },
  InterviewDepth: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DEPTHS: [
    {
      slug: 'screening',
      scoringDimensions: [
        { name: 'relevance', label: 'Relevance', weight: 0.25 },
        { name: 'structure', label: 'STAR Structure', weight: 0.25 },
        { name: 'specificity', label: 'Specificity', weight: 0.25 },
        { name: 'ownership', label: 'Ownership', weight: 0.25 },
      ],
    },
  ],
}))

import { getScoringDimensions, buildRubricPromptSection, evaluateSession } from '@interview/services/eval/evaluationEngine'
import { isFeatureEnabled } from '@shared/featureFlags'
import type { RubricDimension } from '@shared/db/models'

describe('evaluationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
  })

  describe('getScoringDimensions', () => {
    it('returns fallback dimensions for screening', async () => {
      const dims = await getScoringDimensions('pm', 'screening', '3-6')
      expect(dims.length).toBe(4)
      expect(dims[0].name).toBe('relevance')
      expect(dims[1].name).toBe('structure')
      expect(dims[2].name).toBe('specificity')
      expect(dims[3].name).toBe('ownership')
    })

    it('returns default dimensions for unknown type', async () => {
      const dims = await getScoringDimensions('pm', 'unknown-type', '3-6')
      expect(dims.length).toBe(4)
      expect(dims[0].name).toBe('relevance')
    })

    it('dimensions have correct weight range', async () => {
      const dims = await getScoringDimensions('pm', 'screening', '3-6')
      for (const dim of dims) {
        expect(dim.weight).toBeGreaterThanOrEqual(0)
        expect(dim.weight).toBeLessThanOrEqual(1)
      }
    })

    it('weights sum to approximately 1', async () => {
      const dims = await getScoringDimensions('pm', 'screening', '3-6')
      const totalWeight = dims.reduce((sum, d) => sum + d.weight, 0)
      expect(totalWeight).toBeCloseTo(1, 1)
    })
  })

  describe('buildRubricPromptSection', () => {
    it('generates dimension prompt text', () => {
      const dims: RubricDimension[] = [
        {
          name: 'relevance', label: 'Relevance', weight: 0.25,
          description: 'Does the answer address the question?',
          scoringGuide: { excellent: '80-100', good: '60-79', adequate: '40-59', weak: '0-39' },
        },
      ]

      const prompt = buildRubricPromptSection(dims)
      expect(prompt).toContain('relevance')
      expect(prompt).toContain('Relevance')
      expect(prompt).toContain('0.25')
      expect(prompt).toContain('Does the answer address the question?')
      expect(prompt).toContain('80-100')
    })

    it('handles multiple dimensions', () => {
      const dims: RubricDimension[] = [
        { name: 'relevance', label: 'Relevance', weight: 0.5, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
        { name: 'depth', label: 'Depth', weight: 0.5, description: '', scoringGuide: { excellent: '', good: '', adequate: '', weak: '' } },
      ]

      const prompt = buildRubricPromptSection(dims)
      expect(prompt).toContain('relevance')
      expect(prompt).toContain('depth')
    })
  })

  describe('evaluateSession', () => {
    it('aggregates evaluation scores correctly', async () => {
      const result = await evaluateSession({
        domain: 'pm',
        interviewType: 'screening',
        seniorityBand: '3-6',
        evaluations: [
          {
            questionIndex: 0, question: 'Q1', answer: 'A1',
            relevance: 80, structure: 70, specificity: 60, ownership: 90,
            needsFollowUp: false, flags: [],
          },
          {
            questionIndex: 1, question: 'Q2', answer: 'A2',
            relevance: 70, structure: 80, specificity: 50, ownership: 60,
            needsFollowUp: true, followUpQuestion: 'Tell me more', flags: ['vague'],
          },
        ],
      })

      expect(result.dimensionAverages.relevance).toBe(75)
      expect(result.dimensionAverages.structure).toBe(75)
      expect(result.dimensionAverages.specificity).toBe(55)
      expect(result.dimensionAverages.ownership).toBe(75)
      expect(result.allFlags).toContain('vague')
    })

    it('handles empty evaluations', async () => {
      const result = await evaluateSession({
        domain: 'pm',
        interviewType: 'screening',
        seniorityBand: '3-6',
        evaluations: [],
      })

      expect(result.overallWeightedScore).toBe(50)
      expect(result.topStrengths).toEqual([])
      expect(result.allFlags).toEqual([])
    })

    it('includes jdAlignment when present', async () => {
      const result = await evaluateSession({
        domain: 'pm',
        interviewType: 'screening',
        seniorityBand: '3-6',
        evaluations: [{
          questionIndex: 0, question: 'Q1', answer: 'A1',
          relevance: 80, structure: 70, specificity: 60, ownership: 90,
          jdAlignment: 85,
          needsFollowUp: false, flags: [],
        }],
      })

      expect(result.dimensionAverages.jdAlignment).toBe(85)
    })
  })
})
