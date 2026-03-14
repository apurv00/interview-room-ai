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
const mockFindOne = vi.fn()
const mockUpdateOne = vi.fn()

vi.mock('@shared/db/models', () => ({
  PathwayPlan: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: () => ({ sort: () => ({ lean: () => mockFindOne() }) }),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  User: {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          interviewGoal: 'improve_scores',
          targetRole: 'pm',
        }),
      }),
    }),
  },
}))

vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: vi.fn().mockResolvedValue({
    competencies: [
      { name: 'specificity', score: 45, trend: 'stable', confidence: 0.5 },
      { name: 'structure', score: 80, trend: 'improving', confidence: 0.7 },
    ],
    strongAreas: ['structure'],
    weakAreas: ['specificity'],
    overallReadiness: 60,
  }),
  getUserWeaknesses: vi.fn().mockResolvedValue([
    { name: 'generic_answers', description: 'Answers lack specific details', severity: 'moderate', recurrenceCount: 3, linkedCompetencies: ['specificity'] },
  ]),
}))

vi.mock('@learn/services/sessionSummaryService', () => ({
  getRecentSummaries: vi.fn().mockResolvedValue([
    { overallScore: 65, strengths: ['structure'], weaknesses: ['specificity'], majorMistakes: [], topicsCovered: [], competencyScores: {}, sessionDate: new Date(), interviewType: 'hr-screening' },
  ]),
}))

vi.mock('@interview/services/evaluationEngine', () => ({
  evaluateSession: vi.fn().mockResolvedValue({
    dimensionAverages: { relevance: 75, structure: 80, specificity: 45, ownership: 70 },
    overallWeightedScore: 68,
    topStrengths: ['structure'],
    topWeaknesses: ['specificity'],
    allFlags: [],
    competencyBreakdown: {},
  }),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({
          suggestedTasks: [{
            type: 'drill',
            title: 'Metrics Practice',
            description: 'Practice with metrics',
            targetCompetency: 'specificity',
            difficulty: 'medium',
            estimatedMinutes: 15,
          }],
        }) }],
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
    },
  })),
}))

import { getCurrentPathway, markTaskComplete } from '@learn/services/pathwayPlanner'
import { isFeatureEnabled } from '@shared/featureFlags'

const TEST_USER_ID = '507f1f77bcf86cd799439011' // valid ObjectId

describe('pathwayPlanner', () => {
  beforeEach(() => {
    mockFindOneAndUpdate.mockClear()
    mockFindOne.mockClear()
    mockFindOne.mockResolvedValue(null)
    mockUpdateOne.mockClear()
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
  })

  describe('getCurrentPathway', () => {
    it('returns null when feature is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await getCurrentPathway(TEST_USER_ID)
      expect(result).toBeNull()
    })

    it('returns pathway from DB', async () => {
      const mockPathway = {
        readinessLevel: 'developing',
        readinessScore: 55,
        topBlockingWeaknesses: [],
        strengthsToPreserve: ['structure'],
      }
      mockFindOne.mockResolvedValue(mockPathway)

      const result = await getCurrentPathway(TEST_USER_ID)
      expect(result).toEqual(mockPathway)
    })

    it('returns null when no pathway exists', async () => {
      mockFindOne.mockResolvedValue(null)
      const result = await getCurrentPathway(TEST_USER_ID)
      expect(result).toBeNull()
    })
  })

  describe('markTaskComplete', () => {
    it('returns true when task is found and updated', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
      const result = await markTaskComplete(TEST_USER_ID, 'task_1')
      expect(result).toBe(true)
    })

    it('returns false when task is not found', async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 0 })
      const result = await markTaskComplete(TEST_USER_ID, 'nonexistent')
      expect(result).toBe(false)
    })
  })
})
