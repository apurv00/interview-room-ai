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

const mockFindOneAndUpdate = vi.fn()
const mockFind = vi.fn()

vi.mock('@shared/db/models', () => ({
  SessionSummary: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    find: () => ({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: () => mockFind(),
          }),
        }),
      }),
    }),
  },
}))

import { getRecentSummaries, buildHistorySummary } from '@learn/services/sessionSummaryService'
import { isFeatureEnabled } from '@shared/featureFlags'

const TEST_USER_ID = '507f1f77bcf86cd799439011' // valid ObjectId

describe('sessionSummaryService', () => {
  beforeEach(() => {
    mockFindOneAndUpdate.mockClear()
    mockFind.mockClear()
    mockFind.mockResolvedValue([])
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
  })

  describe('getRecentSummaries', () => {
    it('returns empty array when feature is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await getRecentSummaries(TEST_USER_ID)
      expect(result).toEqual([])
    })

    it('returns formatted summaries', async () => {
      const mockSummaries = [
        {
          overallScore: 72,
          strengths: ['good structure'],
          weaknesses: ['lacks specificity'],
          majorMistakes: [],
          topicsCovered: ['leadership'],
          competencyScores: { relevance: 75 },
          sessionDate: new Date('2024-01-15'),
          interviewType: 'screening',
        },
      ]
      mockFind.mockResolvedValue(mockSummaries)

      const result = await getRecentSummaries(TEST_USER_ID, 'pm')
      expect(result).toHaveLength(1)
      expect(result[0].overallScore).toBe(72)
      expect(result[0].strengths).toContain('good structure')
    })

    it('handles empty results', async () => {
      mockFind.mockResolvedValue([])
      const result = await getRecentSummaries(TEST_USER_ID)
      expect(result).toEqual([])
    })
  })

  describe('buildHistorySummary', () => {
    it('returns empty string when no summaries exist', async () => {
      mockFind.mockResolvedValue([])
      const result = await buildHistorySummary(TEST_USER_ID)
      expect(result).toBe('')
    })

    it('builds compact history string from summaries', async () => {
      const mockSummaries = [
        {
          overallScore: 72,
          strengths: ['structure'],
          weaknesses: ['specificity'],
          majorMistakes: ['No metrics given'],
          topicsCovered: ['leadership', 'conflict resolution'],
          competencyScores: { relevance: 75 },
          sessionDate: new Date('2024-01-15'),
          interviewType: 'screening',
        },
      ]
      mockFind.mockResolvedValue(mockSummaries)

      const result = await buildHistorySummary(TEST_USER_ID, 'pm')
      expect(result).toContain('Recent session history')
      expect(result).toContain('72/100')
      expect(result).toContain('screening')
      expect(result).toContain('specificity')
      expect(result).toContain('No metrics given')
      expect(result).toContain('leadership')
    })
  })
})
