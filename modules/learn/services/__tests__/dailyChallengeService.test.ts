import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockDailyChallengeFind = vi.fn()
const mockDailyChallengeFindOne = vi.fn()
const mockDailyChallengeCreate = vi.fn()
const mockDailyChallengeFindOneAndUpdate = vi.fn()
const mockDailyChallengeUpdateOne = vi.fn()

vi.mock('@shared/db/models/DailyChallenge', () => ({
  DailyChallenge: {
    findOne: (...args: unknown[]) => mockDailyChallengeFindOne(...args),
    find: (...args: unknown[]) => mockDailyChallengeFind(...args),
    create: (...args: unknown[]) => mockDailyChallengeCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockDailyChallengeFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockDailyChallengeUpdateOne(...args),
  },
}))

const mockAttemptFind = vi.fn()
const mockAttemptFindOne = vi.fn()
const mockAttemptCreate = vi.fn()
const mockAttemptCountDocuments = vi.fn()

vi.mock('@shared/db/models/DailyChallengeAttempt', () => ({
  DailyChallengeAttempt: {
    find: (...args: unknown[]) => mockAttemptFind(...args),
    findOne: (...args: unknown[]) => mockAttemptFindOne(...args),
    create: (...args: unknown[]) => mockAttemptCreate(...args),
    countDocuments: (...args: unknown[]) => mockAttemptCountDocuments(...args),
  },
}))

const mockQuestionBankFindOne = vi.fn()
vi.mock('@shared/db/models/QuestionBank', () => ({
  QuestionBank: {
    findOne: (...args: unknown[]) => mockQuestionBankFindOne(...args),
  },
}))

const mockCompletion = vi.fn()
vi.mock('@shared/services/modelRouter', () => ({
  completion: (...args: unknown[]) => mockCompletion(...args),
}))

import {
  getTodaysChallenge,
  submitChallengeAnswer,
  hasUserCompletedToday,
  getUserChallengeHistory,
} from '../dailyChallengeService'
import { isFeatureEnabled } from '@shared/featureFlags'

const VALID_USER_ID = '507f1f77bcf86cd799439011'

describe('dailyChallengeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getTodaysChallenge', () => {
    it('returns existing challenge when found', async () => {
      const challenge = {
        date: '2026-03-16',
        question: 'Tell me about a time...',
        domain: 'software-engineering',
        difficulty: 'medium',
        participantCount: 42,
        avgScore: 75,
      }
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(challenge),
      })

      const result = await getTodaysChallenge()

      expect(result).toEqual({
        date: '2026-03-16',
        question: 'Tell me about a time...',
        domain: 'software-engineering',
        difficulty: 'medium',
        participantCount: 42,
        avgScore: 75,
      })
    })

    it('generates from QuestionBank when no existing challenge', async () => {
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      mockQuestionBankFindOne.mockReturnValue({
        skip: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue({
              question: 'Bank question',
              domain: 'software-engineering',
              category: 'leadership',
              targetCompetencies: ['teamwork'],
              idealAnswerPoints: ['point1'],
            }),
          }),
        }),
      })
      mockDailyChallengeCreate.mockResolvedValue({
        toObject: () => ({
          date: '2026-03-16',
          question: 'Bank question',
          domain: 'software-engineering',
          difficulty: 'medium',
          participantCount: 0,
          avgScore: 0,
        }),
      })

      const result = await getTodaysChallenge()

      expect(result).toBeDefined()
      expect(result!.question).toBe('Bank question')
    })

    it('falls back to Claude when QuestionBank returns null', async () => {
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      mockQuestionBankFindOne.mockReturnValue({
        skip: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(null),
          }),
        }),
      })
      mockCompletion.mockResolvedValue({
        text: JSON.stringify({
          question: 'AI-generated question',
          category: 'problem-solving',
          targetCompetencies: ['analysis'],
          idealAnswerPoints: ['point1'],
        }),
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        usedFallback: false,
      })
      mockDailyChallengeCreate.mockResolvedValue({
        toObject: () => ({
          date: '2026-03-16',
          question: 'AI-generated question',
          domain: 'software-engineering',
          difficulty: 'medium',
          participantCount: 0,
          avgScore: 0,
        }),
      })

      const result = await getTodaysChallenge()

      expect(result).toBeDefined()
      expect(mockCompletion).toHaveBeenCalled()
    })

    it('falls back to hardcoded question when Claude fails', async () => {
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      mockQuestionBankFindOne.mockReturnValue({
        skip: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            catch: vi.fn().mockResolvedValue(null),
          }),
        }),
      })
      mockCompletion.mockRejectedValue(new Error('API error'))
      mockDailyChallengeCreate.mockResolvedValue({
        toObject: () => ({
          date: '2026-03-16',
          question: 'Tell me about a time you had to solve a complex problem...',
          domain: 'software-engineering',
          difficulty: 'medium',
          participantCount: 0,
          avgScore: 0,
        }),
      })

      const result = await getTodaysChallenge()

      expect(result).toBeDefined()
      expect(result!.question).toContain('complex problem')
    })

    it('returns null when feature flag disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const result = await getTodaysChallenge()
      expect(result).toBeNull()
    })

    it('returns correct shape with rounded avgScore', async () => {
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          date: '2026-03-16',
          question: 'Test',
          domain: 'product-management',
          difficulty: 'medium',
          participantCount: 5,
          avgScore: 72.6,
        }),
      })

      const result = await getTodaysChallenge()
      expect(result!.avgScore).toBe(73) // Math.round(72.6)
    })
  })

  describe('submitChallengeAnswer', () => {
    it('returns existing attempt if already submitted', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          score: 85,
          breakdown: { relevance: 90, structure: 80, specificity: 85, ownership: 85 },
          percentile: 70,
        }),
      })

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'My answer...')

      expect(result).toBeDefined()
      expect(result!.score).toBe(85)
      expect(mockCompletion).not.toHaveBeenCalled()
    })

    it('scores via Claude and saves attempt', async () => {
      // No existing attempt
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      // Challenge exists
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          question: 'Test question',
          domain: 'software-engineering',
        }),
      })
      // Claude scoring
      mockCompletion.mockResolvedValue({
        text: '{"relevance": 80, "structure": 75, "specificity": 70, "ownership": 85}',
        model: 'claude-sonnet-4-6-20250514',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        usedFallback: false,
      })
      // Attempt counts for percentile
      mockAttemptCountDocuments
        .mockResolvedValueOnce(10) // total attempts
        .mockResolvedValueOnce(6)  // below count
      // Save attempt
      mockAttemptCreate.mockResolvedValue({})
      // Update challenge stats
      mockDailyChallengeFindOneAndUpdate.mockResolvedValue({
        participantCount: 11,
        avgScore: 75,
      })
      mockDailyChallengeUpdateOne.mockResolvedValue({})

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'My detailed answer about a challenging situation...')

      expect(result).toBeDefined()
      expect(result!.score).toBe(78) // Math.round((80+75+70+85)/4) = 77.5 -> 78
      expect(result!.breakdown).toEqual({ relevance: 80, structure: 75, specificity: 70, ownership: 85 })
      expect(result!.percentile).toBe(60) // (6/10)*100 = 60
      expect(mockAttemptCreate).toHaveBeenCalled()
    })

    it('returns null when feature flag disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'answer')
      expect(result).toBeNull()
    })

    it('returns null when challenge not found', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'answer text here')
      expect(result).toBeNull()
    })

    it('handles Claude JSON with code fences', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })
      mockDailyChallengeFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ question: 'Test', domain: 'pm' }),
      })
      mockCompletion.mockResolvedValue({
        text: '```json\n{"relevance": 80, "structure": 80, "specificity": 80, "ownership": 80}\n```',
        model: 'claude-sonnet-4-6-20250514',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        usedFallback: false,
      })
      mockAttemptCountDocuments.mockResolvedValue(0)
      mockAttemptCreate.mockResolvedValue({})
      mockDailyChallengeFindOneAndUpdate.mockResolvedValue({ participantCount: 1, avgScore: 0 })
      mockDailyChallengeUpdateOne.mockResolvedValue({})

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'My answer here...')

      expect(result).toBeDefined()
      expect(result!.score).toBe(80)
    })

    it('updates challenge participantCount atomically', async () => {
      mockAttemptFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) })
      mockDailyChallengeFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ question: 'Q', domain: 'd' }) })
      mockCompletion.mockResolvedValue({
        text: '{"relevance":70,"structure":70,"specificity":70,"ownership":70}',
        model: 'claude-sonnet-4-6-20250514',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        usedFallback: false,
      })
      mockAttemptCountDocuments.mockResolvedValue(0)
      mockAttemptCreate.mockResolvedValue({})
      mockDailyChallengeFindOneAndUpdate.mockResolvedValue({ participantCount: 1, avgScore: 0 })
      mockDailyChallengeUpdateOne.mockResolvedValue({})

      await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'Detailed answer here')

      expect(mockDailyChallengeFindOneAndUpdate).toHaveBeenCalledWith(
        { date: '2026-03-16' },
        { $inc: { participantCount: 1 } },
        { new: true },
      )
    })

    it('returns null on error', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB error')),
      })

      const result = await submitChallengeAnswer(VALID_USER_ID, '2026-03-16', 'answer here')
      expect(result).toBeNull()
    })
  })

  describe('hasUserCompletedToday', () => {
    it('returns true when attempt exists', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ score: 80 }),
      })

      const result = await hasUserCompletedToday(VALID_USER_ID)
      expect(result).toBe(true)
    })

    it('returns false when no attempt', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      })

      const result = await hasUserCompletedToday(VALID_USER_ID)
      expect(result).toBe(false)
    })

    it('returns false on DB error', async () => {
      mockAttemptFindOne.mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB error')),
      })

      const result = await hasUserCompletedToday(VALID_USER_ID)
      expect(result).toBe(false)
    })
  })

  describe('getUserChallengeHistory', () => {
    it('returns past attempts sorted by date', async () => {
      const attempts = [
        { challengeDate: '2026-03-16', score: 85, breakdown: { relevance: 90, structure: 80, specificity: 85, ownership: 85 }, percentile: 70 },
        { challengeDate: '2026-03-15', score: 72, breakdown: { relevance: 75, structure: 70, specificity: 70, ownership: 73 }, percentile: 50 },
      ]
      mockAttemptFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue(attempts),
            }),
          }),
        }),
      })

      const result = await getUserChallengeHistory(VALID_USER_ID)

      expect(result).toHaveLength(2)
      expect(result[0].challengeDate).toBe('2026-03-16')
      expect(result[0].score).toBe(85)
    })

    it('returns empty array when no history', async () => {
      mockAttemptFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      })

      const result = await getUserChallengeHistory(VALID_USER_ID)
      expect(result).toEqual([])
    })

    it('returns empty array on error', async () => {
      mockAttemptFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockRejectedValue(new Error('DB error')),
            }),
          }),
        }),
      })

      const result = await getUserChallengeHistory(VALID_USER_ID)
      expect(result).toEqual([])
    })
  })

})
