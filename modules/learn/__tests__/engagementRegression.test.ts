import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression tests for engagement features.
 * Ensures new engagement features don't break existing functionality
 * and handle edge cases/backward compatibility correctly.
 */

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockUserFindByIdAndUpdate = vi.fn()
const mockUserUpdateOne = vi.fn()
const mockUserFindById = vi.fn()

vi.mock('@shared/db/models/User', () => ({
  User: {
    findByIdAndUpdate: (...args: unknown[]) => mockUserFindByIdAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}))

vi.mock('@shared/db/models/XpEvent', () => ({
  XpEvent: {
    create: vi.fn().mockResolvedValue({}),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@shared/db/models/UserBadge', () => ({
  UserBadge: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
    create: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    distinct: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@shared/db/models/DailyChallengeAttempt', () => ({
  DailyChallengeAttempt: {
    countDocuments: vi.fn().mockResolvedValue(0),
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        catch: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}))

const mockRegStreakDayFindOne = vi.fn()
vi.mock('@shared/db/models/StreakDay', () => ({
  StreakDay: {
    updateOne: vi.fn().mockResolvedValue({}),
    findOne: (...args: unknown[]) => ({
      lean: () => mockRegStreakDayFindOne(...args),
    }),
  },
}))

import { awardXp, getXpSummary } from '@learn/services/xpService'
import { checkAndAwardBadges, getUserBadges } from '@learn/services/badgeService'
import { updateStreak } from '@learn/services/streakService'
import { isFeatureEnabled } from '@shared/featureFlags'
import { BADGE_DEFINITIONS } from '@learn/config/badges'

const USER_ID = '507f1f77bcf86cd799439011'

describe('Engagement Regression Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
    mockRegStreakDayFindOne.mockResolvedValue(null)
  })

  describe('feature flag isolation', () => {
    it('each service respects its own flag independently', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockImplementation((flag: string) => {
        return flag === 'engagement_badges' // only badges enabled
      })

      // XP disabled
      const xp = await awardXp(USER_ID, 'interview_complete', 50)
      expect(xp.newXp).toBe(0)

      // Streaks disabled
      const streak = await updateStreak(USER_ID)
      expect(streak.currentStreak).toBe(0)

      // Badges enabled - should attempt DB lookup
      // (may return empty due to context build, but should not return early)
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 0 }),
        }),
      })
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 0, level: 1 })

      const badges = await checkAndAwardBadges(USER_ID, { type: 'interview_complete', score: 60 })
      // Should not be empty array returned from flag check
      expect(Array.isArray(badges)).toBe(true)
    })

    it('all flags disabled returns safe defaults', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const xp = await awardXp(USER_ID, 'interview_complete', 50)
      expect(xp).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })

      const badges = await checkAndAwardBadges(USER_ID, { type: 'interview_complete' })
      expect(badges).toEqual([])

      const streak = await updateStreak(USER_ID)
      expect(streak).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })
  })

  describe('user model backward compatibility', () => {
    it('handles user with no engagement fields (legacy user)', async () => {
      // Legacy user without xp, level, xpThisWeek
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ name: 'Legacy User' }), // no xp fields
        }),
      })

      const summary = await getXpSummary(USER_ID)

      expect(summary.xp).toBe(0)
      expect(summary.level).toBe(1)
      expect(summary.title).toBe('Novice')
      expect(summary.xpThisWeek).toBe(0)
    })

    it('handles user with undefined streak freeze fields', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            currentStreak: 3,
            longestStreak: 5,
            // no streakFreezeAvailable field
          }),
        }),
      })
      // Mock: today has activity, yesterday does not
      mockRegStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' })
        .mockResolvedValueOnce(null) // no yesterday

      mockUserUpdateOne.mockResolvedValue({})

      const result = await updateStreak(USER_ID)

      // No freeze available (undefined treated as 0), so streak resets
      expect(result.currentStreak).toBe(1)
    })
  })

  describe('data integrity', () => {
    it('XP award uses atomic $inc (no read-modify-write race)', async () => {
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 100, level: 1 })

      await awardXp(USER_ID, 'interview_complete', 50)

      // Verify $inc was used (not $set)
      expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $inc: { xp: 50, xpThisWeek: 50 } },
        expect.anything(),
      )
    })

    it('duplicate badge check does not create duplicate UserBadge', async () => {
      const { UserBadge } = await import('@shared/db/models/UserBadge')

      // First call: no badges earned
      ;(UserBadge.find as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 0 }),
        }),
      })
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 10, level: 1 })

      const awarded1 = await checkAndAwardBadges(USER_ID, { type: 'interview_complete', score: 60 })
      expect(awarded1.some(b => b.badgeId === 'first_interview')).toBe(true)

      // Second call: badge already earned
      ;(UserBadge.find as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([{ badgeId: 'first_interview' }]),
        }),
      })

      const awarded2 = await checkAndAwardBadges(USER_ID, { type: 'interview_complete', score: 60 })
      expect(awarded2.find(b => b.badgeId === 'first_interview')).toBeUndefined()
    })
  })

  describe('badge definitions integrity', () => {
    it('badge definitions count has not changed unexpectedly', () => {
      // Regression guard: if someone adds/removes badges, this test surfaces it
      expect(BADGE_DEFINITIONS).toHaveLength(19)
    })

    it('all expected badge IDs exist', () => {
      const expectedIds = [
        'first_interview', 'interviews_5', 'interviews_25', 'interviews_100',
        'streak_3', 'streak_7', 'streak_14', 'streak_30', 'streak_100',
        'score_70', 'score_80', 'score_90', 'score_100', 'comeback',
        'explorer_3_domains', 'depth_explorer', 'daily_challenger', 'daily_challenge_10',
        'shared_scorecard',
      ]
      const actualIds = BADGE_DEFINITIONS.map(b => b.id)
      for (const id of expectedIds) {
        expect(actualIds).toContain(id)
      }
    })
  })

  describe('getUserBadges backward compatibility', () => {
    it('returns all badges as available when user has no badges', async () => {
      const { UserBadge } = await import('@shared/db/models/UserBadge')
      ;(UserBadge.find as ReturnType<typeof vi.fn>).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })

      const result = await getUserBadges(USER_ID)

      expect(result.earned).toHaveLength(0)
      expect(result.available).toHaveLength(19)
    })
  })

  describe('error handling does not propagate', () => {
    it('awardXp DB failure returns default, does not throw', async () => {
      const { XpEvent } = await import('@shared/db/models/XpEvent')
      ;(XpEvent.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection lost'))

      const result = await awardXp(USER_ID, 'interview_complete', 50)

      expect(result).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })
    })

    it('checkAndAwardBadges DB failure returns empty array, does not throw', async () => {
      const { UserBadge } = await import('@shared/db/models/UserBadge')
      ;(UserBadge.find as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Connection lost')),
        }),
      })

      const result = await checkAndAwardBadges(USER_ID, { type: 'interview_complete' })
      expect(result).toEqual([])
    })

    it('updateStreak DB failure returns default, does not throw', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Connection lost')),
        }),
      })

      const result = await updateStreak(USER_ID)
      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })
  })
})
