import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db/models', () => ({
  BenchmarkCase: {
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  },
  EvaluationRubric: {
    findOne: vi.fn().mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }),
  },
  InterviewDepth: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}))

vi.mock('@/lib/db/seed', () => ({
  FALLBACK_DEPTHS: [
    {
      slug: 'hr-screening',
      scoringDimensions: [
        { name: 'relevance', label: 'Relevance', weight: 0.25 },
        { name: 'structure', label: 'STAR Structure', weight: 0.25 },
        { name: 'specificity', label: 'Specificity', weight: 0.25 },
        { name: 'ownership', label: 'Ownership', weight: 0.25 },
      ],
    },
  ],
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
    },
  })),
}))

import { runBenchmarkSuite } from '@/lib/services/benchmarkService'
import { isFeatureEnabled } from '@/lib/featureFlags'

describe('benchmarkService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('runBenchmarkSuite', () => {
    it('returns empty result when feature is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(0)
      expect(result.passed).toBe(0)
      expect(result.results).toEqual([])
    })

    it('returns empty result when no cases found', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      const result = await runBenchmarkSuite()
      expect(result.totalCases).toBe(0)
      expect(result.passRate).toBe(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.runAt).toBeInstanceOf(Date)
    })

    it('returns result with correct structure', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(true)
      const result = await runBenchmarkSuite({ domain: 'pm' })
      expect(result).toHaveProperty('totalCases')
      expect(result).toHaveProperty('passed')
      expect(result).toHaveProperty('failed')
      expect(result).toHaveProperty('passRate')
      expect(result).toHaveProperty('avgScoreAccuracy')
      expect(result).toHaveProperty('avgStrengthOverlap')
      expect(result).toHaveProperty('avgWeaknessOverlap')
      expect(result).toHaveProperty('results')
      expect(result).toHaveProperty('runAt')
      expect(result).toHaveProperty('durationMs')
    })
  })
})
