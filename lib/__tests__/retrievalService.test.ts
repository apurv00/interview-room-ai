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

const mockFind = vi.fn()
const mockUpdateMany = vi.fn()

vi.mock('@shared/db/models', () => ({
  QuestionBank: {
    find: (...args: unknown[]) => ({
      sort: () => ({
        limit: () => ({
          lean: () => mockFind(...args),
        }),
      }),
    }),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
  },
  CompanyPattern: {
    find: (...args: unknown[]) => ({
      limit: () => ({
        lean: () => mockFind(...args),
      }),
      lean: () => mockFind(...args),
    }),
  },
  User: {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    }),
  },
}))

import { retrieveQuestions, getQuestionBankContext } from '@/lib/services/retrievalService'
import { isFeatureEnabled } from '@shared/featureFlags'

describe('retrievalService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
    mockUpdateMany.mockResolvedValue({})
  })

  describe('retrieveQuestions', () => {
    it('returns empty array when feature is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await retrieveQuestions({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toEqual([])
    })

    it('returns formatted questions', async () => {
      const mockQuestions = [
        {
          _id: 'q1',
          question: 'Tell me about a product launch',
          category: 'behavioral',
          targetCompetencies: ['product_sense'],
          difficulty: 'medium',
          idealAnswerPoints: ['STAR structure', 'Metrics'],
        },
      ]
      mockFind.mockResolvedValue(mockQuestions)

      const result = await retrieveQuestions({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toHaveLength(1)
      expect(result[0].question).toBe('Tell me about a product launch')
      expect(result[0].category).toBe('behavioral')
    })

    it('handles empty results', async () => {
      mockFind.mockResolvedValue([])
      const result = await retrieveQuestions({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toEqual([])
    })
  })

  describe('getQuestionBankContext', () => {
    it('returns empty string when feature is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await getQuestionBankContext({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toBe('')
    })

    it('returns formatted context string', async () => {
      mockFind.mockResolvedValue([
        {
          _id: 'q1',
          question: 'Tell me about a product launch',
          category: 'behavioral',
          targetCompetencies: ['product_sense'],
          difficulty: 'medium',
          idealAnswerPoints: [],
        },
      ])

      const result = await getQuestionBankContext({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toContain('REFERENCE QUESTIONS')
      expect(result).toContain('Tell me about a product launch')
    })

    it('returns empty string when no questions found', async () => {
      mockFind.mockResolvedValue([])
      const result = await getQuestionBankContext({ domain: 'pm', interviewType: 'hr-screening' })
      expect(result).toBe('')
    })
  })
})
