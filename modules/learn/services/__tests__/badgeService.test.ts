import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@shared/redis', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}))

const mockAwardXp = vi.fn().mockResolvedValue({ newXp: 10, newLevel: 1, leveledUp: false, title: 'Novice' })
vi.mock('../xpService', () => ({
  awardXp: (...args: unknown[]) => mockAwardXp(...args),
}))

const mockUserBadgeFind = vi.fn()
const mockUserBadgeCreate = vi.fn()
const mockUserBadgeUpdateOne = vi.fn()

vi.mock('@shared/db/models/UserBadge', () => ({
  UserBadge: {
    find: (...args: unknown[]) => mockUserBadgeFind(...args),
    create: (...args: unknown[]) => mockUserBadgeCreate(...args),
    updateOne: (...args: unknown[]) => mockUserBadgeUpdateOne(...args),
  },
}))

const mockUserFindById = vi.fn()
vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}))

const mockInterviewSessionDistinct = vi.fn()
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    distinct: (...args: unknown[]) => mockInterviewSessionDistinct(...args),
  },
}))

const mockDailyChallengeAttemptCount = vi.fn()
vi.mock('@shared/db/models/DailyChallengeAttempt', () => ({
  DailyChallengeAttempt: {
    countDocuments: (...args: unknown[]) => mockDailyChallengeAttemptCount(...args),
  },
}))

import { checkAndAwardBadges, getUserBadges, getUnnotifiedBadges, markBadgeNotified } from '../badgeService'
import { isFeatureEnabled } from '@shared/featureFlags'

const VALID_USER_ID = '507f1f77bcf86cd799439011'

describe('badgeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  describe('checkAndAwardBadges', () => {
    function setupContext(overrides: Record<string, unknown> = {}) {
      // No badges earned yet
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      // User data
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            interviewCount: 1,
            currentStreak: 0,
            ...overrides,
          }),
        }),
      })
      // Domain/depth stats
      mockInterviewSessionDistinct.mockResolvedValue([])
      // Daily challenge count
      mockDailyChallengeAttemptCount.mockResolvedValue(0)
      // Badge creation
      mockUserBadgeCreate.mockResolvedValue({})
    }

    it('awards first_interview badge when interviewCount is 1', async () => {
      setupContext({ interviewCount: 1 })

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
        score: 60,
      })

      expect(awarded.some(b => b.badgeId === 'first_interview')).toBe(true)
      expect(mockUserBadgeCreate).toHaveBeenCalled()
      expect(mockAwardXp).toHaveBeenCalledWith(VALID_USER_ID, 'badge_earned', expect.any(Number), expect.objectContaining({ badgeId: 'first_interview' }))
    })

    it('skips already-earned badges', async () => {
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([{ badgeId: 'first_interview' }]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 0 }),
        }),
      })
      mockInterviewSessionDistinct.mockResolvedValue([])
      mockDailyChallengeAttemptCount.mockResolvedValue(0)

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
        score: 60,
      })

      expect(awarded.find(b => b.badgeId === 'first_interview')).toBeUndefined()
    })

    it('awards multiple badges when conditions met (e.g., first interview + score_70)', async () => {
      setupContext({ interviewCount: 1 })

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
        score: 75,
      })

      const ids = awarded.map(b => b.badgeId)
      expect(ids).toContain('first_interview')
      expect(ids).toContain('score_70')
    })

    it('returns empty array when feature flag disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
      })

      expect(awarded).toEqual([])
      expect(mockUserBadgeFind).not.toHaveBeenCalled()
    })

    it('handles DB errors gracefully', async () => {
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      })

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
      })

      expect(awarded).toEqual([])
    })

    it('handles duplicate key error (11000) gracefully', async () => {
      setupContext({ interviewCount: 1 })
      const dupError = new Error('Duplicate key') as Error & { code: number }
      dupError.code = 11000
      mockUserBadgeCreate.mockRejectedValue(dupError)

      const awarded = await checkAndAwardBadges(VALID_USER_ID, {
        type: 'interview_complete',
        score: 60,
      })

      // Should not throw, just skip
      expect(awarded).toEqual([])
    })
  })

  describe('getUserBadges', () => {
    it('returns earned and available badges', async () => {
      const earnedAt = new Date('2026-03-15')
      mockUserBadgeFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { badgeId: 'first_interview', earnedAt },
          ]),
        }),
      })

      const result = await getUserBadges(VALID_USER_ID)

      expect(result.earned).toHaveLength(1)
      expect(result.earned[0].id).toBe('first_interview')
      expect(result.earned[0].earnedAt).toEqual(earnedAt)
      expect(result.available.length).toBe(26) // 27 total - 1 earned
    })

    it('returns all badges as available when none earned', async () => {
      mockUserBadgeFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })

      const result = await getUserBadges(VALID_USER_ID)

      expect(result.earned).toHaveLength(0)
      expect(result.available).toHaveLength(27)
    })

    it('handles DB error gracefully', async () => {
      mockUserBadgeFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      })

      const result = await getUserBadges(VALID_USER_ID)

      expect(result.earned).toEqual([])
      expect(result.available).toHaveLength(27)
    })
  })

  describe('getUnnotifiedBadges', () => {
    it('returns unnotified badges with definitions', async () => {
      mockUserBadgeFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { badgeId: 'first_interview', earnedAt: new Date(), notified: false },
          ]),
        }),
      })

      const result = await getUnnotifiedBadges(VALID_USER_ID)

      expect(result).toHaveLength(1)
      expect(result[0].badgeId).toBe('first_interview')
      expect(result[0].name).toBe('First Steps')
      expect(result[0].icon).toBe('🎯')
    })

    it('returns empty array when no unnotified', async () => {
      mockUserBadgeFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })

      const result = await getUnnotifiedBadges(VALID_USER_ID)
      expect(result).toEqual([])
    })
  })

  describe('markBadgeNotified', () => {
    it('updates badge to notified', async () => {
      mockUserBadgeUpdateOne.mockResolvedValue({})

      await markBadgeNotified(VALID_USER_ID, 'first_interview')

      expect(mockUserBadgeUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ badgeId: 'first_interview' }),
        { notified: true },
      )
    })
  })
})
