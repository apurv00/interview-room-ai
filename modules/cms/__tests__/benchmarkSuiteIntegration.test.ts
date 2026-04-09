import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockBenchFind = vi.fn()
vi.mock('@shared/db/models', () => ({
  BenchmarkCase: {
    find: (...args: unknown[]) => ({ lean: () => mockBenchFind(...args) }),
  },
}))

const mockEvaluateStructured = vi.fn()
vi.mock('@interview/services/evaluationEngine', () => ({
  evaluateStructured: (...args: unknown[]) => mockEvaluateStructured(...args),
}))

import { runBenchmarkSuite, runConsistencyCheck } from '@cms/services/benchmarkService'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const strongCase = {
  caseId: 'strong_star',
  domain: 'product',
  interviewType: 'behavioral',
  seniorityBand: 'senior',
  question: 'Tell me about a time...',
  candidateAnswer: 'Strong STAR answer with metrics.',
  expectedCompetencyScoreBands: {
    relevance: { min: 80, max: 100 },
    structure: { min: 80, max: 100 },
    specificity: { min: 80, max: 100 },
    ownership: { min: 80, max: 100 },
  },
  expectedStrengthTags: ['quantified impact', 'clear ownership'],
  expectedWeaknessTags: [],
  isActive: true,
}

const weakCase = {
  caseId: 'vague_answer',
  domain: 'product',
  interviewType: 'behavioral',
  seniorityBand: 'senior',
  question: 'Tell me about a time...',
  candidateAnswer: 'Vague response.',
  expectedCompetencyScoreBands: {
    relevance: { min: 20, max: 45 },
    structure: { min: 20, max: 45 },
  },
  expectedStrengthTags: [],
  expectedWeaknessTags: ['vague', 'no metrics'],
  isActive: true,
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('benchmarkService integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('runBenchmarkSuite', () => {
    it('marks a case passed when scores fall inside bands and tags overlap', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      mockEvaluateStructured.mockResolvedValue({
        scores: { relevance: 90, structure: 85, specificity: 88, ownership: 82 },
        weightedScore: 86,
        strengthTags: ['quantified impact', 'clear ownership'],
        weaknessTags: [],
        flags: [],
        needsFollowUp: false,
      })

      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(1)
      expect(result.passed).toBe(1)
      expect(result.failed).toBe(0)
      expect(result.passRate).toBe(1)
      expect(result.avgScoreAccuracy).toBeCloseTo(1, 5)
      expect(result.avgStrengthOverlap).toBeCloseTo(1, 5)
    })

    it('marks a case failed when scores fall outside bands', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      mockEvaluateStructured.mockResolvedValue({
        scores: { relevance: 30, structure: 25, specificity: 20, ownership: 15 },
        weightedScore: 22,
        strengthTags: [],
        weaknessTags: ['vague'],
        flags: [],
        needsFollowUp: true,
      })

      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(1)
      expect(result.passed).toBe(0)
      expect(result.failed).toBe(1)
      expect(result.passRate).toBe(0)
      expect(result.avgScoreAccuracy).toBeLessThan(0.5)
    })

    it('computes aggregate metrics across multiple cases', async () => {
      mockBenchFind.mockResolvedValue([strongCase, weakCase])
      mockEvaluateStructured
        .mockResolvedValueOnce({
          scores: { relevance: 90, structure: 90, specificity: 90, ownership: 90 },
          weightedScore: 90,
          strengthTags: ['quantified impact', 'clear ownership'],
          weaknessTags: [],
          flags: [],
          needsFollowUp: false,
        })
        .mockResolvedValueOnce({
          scores: { relevance: 30, structure: 30 },
          weightedScore: 30,
          strengthTags: [],
          weaknessTags: ['vague', 'no metrics'],
          flags: ['vague'],
          needsFollowUp: true,
        })

      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(2)
      expect(result.passed).toBe(2) // both match expectations
      expect(result.results).toHaveLength(2)
    })

    it('continues running remaining cases when one evaluation throws', async () => {
      mockBenchFind.mockResolvedValue([strongCase, weakCase])
      mockEvaluateStructured
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce({
          scores: { relevance: 30, structure: 30 },
          weightedScore: 30,
          strengthTags: [],
          weaknessTags: ['vague', 'no metrics'],
          flags: [],
          needsFollowUp: true,
        })

      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(1) // only the one that succeeded
    })
  })

  describe('runConsistencyCheck', () => {
    it('runs N evaluations per case and reports dimension stats', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      // Returns varying scores across 3 runs
      mockEvaluateStructured
        .mockResolvedValueOnce({
          scores: { relevance: 88, structure: 85, specificity: 90, ownership: 82 },
          weightedScore: 86,
          strengthTags: ['quantified impact'],
          weaknessTags: [],
        })
        .mockResolvedValueOnce({
          scores: { relevance: 90, structure: 87, specificity: 88, ownership: 84 },
          weightedScore: 87,
          strengthTags: ['quantified impact'],
          weaknessTags: [],
        })
        .mockResolvedValueOnce({
          scores: { relevance: 92, structure: 86, specificity: 92, ownership: 80 },
          weightedScore: 87,
          strengthTags: ['quantified impact'],
          weaknessTags: [],
        })

      const report = await runConsistencyCheck({ runs: 3 })
      expect(report.totalCases).toBe(1)
      expect(report.runsPerCase).toBe(3)
      expect(report.results).toHaveLength(1)
      const caseResult = report.results[0]
      expect(caseResult.runs).toBe(3)
      expect(caseResult.dimensionStats.length).toBe(4)
      expect(caseResult.overallScore.mean).toBeCloseTo(86.67, 1)
      expect(caseResult.strengthTagStability).toBe(1)
      expect(caseResult.errors).toBe(0)
      expect(report.meanStdDev).toBeGreaterThan(0)
    })

    it('counts errors when evaluator returns null', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      mockEvaluateStructured
        .mockResolvedValueOnce({
          scores: { relevance: 80 },
          weightedScore: 80,
          strengthTags: [],
          weaknessTags: [],
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          scores: { relevance: 82 },
          weightedScore: 82,
          strengthTags: [],
          weaknessTags: [],
        })

      const report = await runConsistencyCheck({ runs: 3 })
      expect(report.results[0].errors).toBe(1)
      expect(report.results[0].overallScore.values).toHaveLength(2)
    })

    it('passes temperature override to evaluator', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      mockEvaluateStructured.mockResolvedValue({
        scores: { relevance: 80 },
        weightedScore: 80,
        strengthTags: [],
        weaknessTags: [],
      })
      await runConsistencyCheck({ runs: 2, temperature: 0.2 })
      const firstCall = mockEvaluateStructured.mock.calls[0][0]
      expect(firstCall.temperature).toBe(0.2)
    })

    it('omits temperature when not provided', async () => {
      mockBenchFind.mockResolvedValue([strongCase])
      mockEvaluateStructured.mockResolvedValue({
        scores: { relevance: 80 },
        weightedScore: 80,
        strengthTags: [],
        weaknessTags: [],
      })
      await runConsistencyCheck({ runs: 1 })
      const firstCall = mockEvaluateStructured.mock.calls[0][0]
      expect(firstCall).not.toHaveProperty('temperature')
    })
  })
})
