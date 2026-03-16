import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Integration tests for the engagement reward chain.
 * Tests cross-service interactions where multiple services work together.
 * Mocks only external boundaries (DB, Anthropic SDK).
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

// Shared mock state for user across services
let mockUserData: Record<string, unknown> = {}
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

const mockXpEventCreate = vi.fn()
vi.mock('@shared/db/models/XpEvent', () => ({
  XpEvent: {
    create: (...args: unknown[]) => mockXpEventCreate(...args),
  },
}))

const mockUserBadgeFind = vi.fn()
const mockUserBadgeCreate = vi.fn()
vi.mock('@shared/db/models/UserBadge', () => ({
  UserBadge: {
    find: (...args: unknown[]) => mockUserBadgeFind(...args),
    create: (...args: unknown[]) => mockUserBadgeCreate(...args),
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

const mockStreakDayUpdateOne = vi.fn()
const mockStreakDayFindOne = vi.fn()
vi.mock('@shared/db/models/StreakDay', () => ({
  StreakDay: {
    updateOne: (...args: unknown[]) => mockStreakDayUpdateOne(...args),
    findOne: (...args: unknown[]) => ({
      lean: () => mockStreakDayFindOne(...args),
    }),
  },
}))

import { awardXp } from '@learn/services/xpService'
import { checkAndAwardBadges } from '@learn/services/badgeService'
import { recordActivity, updateStreak } from '@learn/services/streakService'
import { isFeatureEnabled } from '@shared/featureFlags'

const USER_ID = '507f1f77bcf86cd799439011'

describe('Engagement Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))

    mockUserData = { xp: 0, level: 1, interviewCount: 0, currentStreak: 0, longestStreak: 0, streakFreezeAvailable: 0 }
    mockXpEventCreate.mockResolvedValue({})
    mockUserBadgeCreate.mockResolvedValue({})
    mockStreakDayUpdateOne.mockResolvedValue({})
    mockUserUpdateOne.mockResolvedValue({})
    mockInterviewSessionDistinct.mockResolvedValue([])
    mockDailyChallengeAttemptCount.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('interview completion flow', () => {
    it('awards XP after interview completion', async () => {
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })

      const result = await awardXp(USER_ID, 'interview_complete', 50)

      expect(result.newXp).toBe(50)
      expect(mockXpEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'interview_complete', amount: 50 }),
      )
    })

    it('awards first_interview badge when conditions met', async () => {
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 0 }),
        }),
      })
      // For awardXp inside badge service
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 10, level: 1 })

      const badges = await checkAndAwardBadges(USER_ID, {
        type: 'interview_complete',
        score: 65,
      })

      expect(badges.some(b => b.badgeId === 'first_interview')).toBe(true)
    })

    it('records activity and updates streak after interview', async () => {
      // recordActivity
      await recordActivity(USER_ID)
      expect(mockStreakDayUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-03-16' }),
        expect.anything(),
        { upsert: true },
      )

      // updateStreak with yesterday activity
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ currentStreak: 3, longestStreak: 5, streakFreezeAvailable: 0 }),
        }),
      })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' })
        .mockResolvedValueOnce({ date: '2026-03-15', type: 'active' })

      const streakResult = await updateStreak(USER_ID)
      expect(streakResult.currentStreak).toBe(4)
    })
  })

  describe('first interview awards both XP and badge', () => {
    it('chains XP + badge + streak correctly', async () => {
      // Step 1: Award interview XP
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })
      const xpResult = await awardXp(USER_ID, 'interview_complete', 50)
      expect(xpResult.newXp).toBe(50)

      // Step 2: Check badges
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 1 }),
        }),
      })
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 60, level: 1 }) // after badge XP

      const badges = await checkAndAwardBadges(USER_ID, {
        type: 'interview_complete',
        score: 60,
      })
      expect(badges.length).toBeGreaterThanOrEqual(1)

      // Step 3: Record activity
      await recordActivity(USER_ID)
      expect(mockStreakDayUpdateOne).toHaveBeenCalled()

      // Step 4: Update streak
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ currentStreak: 0, longestStreak: 0, streakFreezeAvailable: 0 }),
        }),
      })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' })
        .mockResolvedValueOnce(null) // first day

      const streak = await updateStreak(USER_ID)
      expect(streak.currentStreak).toBe(1) // first day
    })
  })

  describe('high score interview triggers score badge', () => {
    it('awards score_90 badge for score of 92', async () => {
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 5, currentStreak: 0 }),
        }),
      })
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 100, level: 1 })

      const badges = await checkAndAwardBadges(USER_ID, {
        type: 'interview_complete',
        score: 92,
      })

      const ids = badges.map(b => b.badgeId)
      expect(ids).toContain('score_90')
      expect(ids).toContain('score_80')
      expect(ids).toContain('score_70')
    })
  })

  describe('XP level-up cascade', () => {
    it('crossing 100 XP boundary triggers level up', async () => {
      // User at 90 XP, award 10 more
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 100, level: 1 })

      const result = await awardXp(USER_ID, 'drill_complete', 10)

      expect(result.leveledUp).toBe(true)
      expect(result.newLevel).toBe(2)
      expect(result.title).toBe('Beginner')
    })

    it('multiple awards accumulate XP correctly', async () => {
      // First award
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })
      const r1 = await awardXp(USER_ID, 'interview_complete', 50)
      expect(r1.newXp).toBe(50)

      // Second award
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 60, level: 1 })
      const r2 = await awardXp(USER_ID, 'drill_complete', 10)
      expect(r2.newXp).toBe(60)
    })
  })

  describe('streak freeze flow', () => {
    it('freeze consumed preserves streak', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            currentStreak: 7,
            longestStreak: 7,
            streakFreezeAvailable: 1,
          }),
        }),
      })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' }) // today
        .mockResolvedValueOnce(null) // yesterday missing

      const result = await updateStreak(USER_ID)

      expect(result.currentStreak).toBe(8) // preserved + incremented
      expect(result.frozeToday).toBe(true)
    })
  })

  describe('feature flag isolation', () => {
    it('disabling engagement_xp stops XP but badges still work', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockImplementation((flag: string) => flag !== 'engagement_xp')

      const xpResult = await awardXp(USER_ID, 'interview_complete', 50)
      expect(xpResult.newXp).toBe(0)

      // Badges should still work (different flag)
      mockUserBadgeFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      })
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ interviewCount: 1, currentStreak: 0 }),
        }),
      })
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 0, level: 1 })

      const badges = await checkAndAwardBadges(USER_ID, { type: 'interview_complete', score: 60 })
      // Badge service calls awardXp, which will return 0 because engagement_xp is off
      // But badge creation still happens
      expect(badges.some(b => b.badgeId === 'first_interview')).toBe(true)
    })

    it('disabling all engagement flags returns defaults everywhere', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const xp = await awardXp(USER_ID, 'interview_complete', 50)
      expect(xp).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })

      const badges = await checkAndAwardBadges(USER_ID, { type: 'interview_complete' })
      expect(badges).toEqual([])

      await recordActivity(USER_ID) // no-op
      expect(mockStreakDayUpdateOne).not.toHaveBeenCalled()

      const streak = await updateStreak(USER_ID)
      expect(streak).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })
  })
})
