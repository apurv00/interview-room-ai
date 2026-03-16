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

const mockStreakDayUpdateOne = vi.fn()
const mockStreakDayFindOne = vi.fn()
const mockStreakDayFind = vi.fn()

vi.mock('@shared/db/models/StreakDay', () => ({
  StreakDay: {
    updateOne: (...args: unknown[]) => mockStreakDayUpdateOne(...args),
    findOne: (...args: unknown[]) => ({
      lean: () => mockStreakDayFindOne(...args),
    }),
    find: (...args: unknown[]) => mockStreakDayFind(...args),
  },
}))

const mockUserFindById = vi.fn()
const mockUserUpdateOne = vi.fn()
const mockUserFind = vi.fn()

vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
    updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
    find: (...args: unknown[]) => mockUserFind(...args),
  },
}))

import { recordActivity, updateStreak, getStreakCalendar, getStreakLeaderboard, refreshWeeklyFreeze } from '../streakService'
import { isFeatureEnabled } from '@shared/featureFlags'

const VALID_USER_ID = '507f1f77bcf86cd799439011'

describe('streakService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('recordActivity', () => {
    it('upserts StreakDay for today with type active', async () => {
      mockStreakDayUpdateOne.mockResolvedValue({})

      await recordActivity(VALID_USER_ID)

      expect(mockStreakDayUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-03-16' }),
        expect.objectContaining({
          $inc: { activities: 1 },
          $setOnInsert: expect.objectContaining({ type: 'active', date: '2026-03-16' }),
        }),
        { upsert: true },
      )
    })

    it('does nothing when feature flag disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      await recordActivity(VALID_USER_ID)

      expect(mockStreakDayUpdateOne).not.toHaveBeenCalled()
    })

    it('handles DB error gracefully', async () => {
      mockStreakDayUpdateOne.mockRejectedValue(new Error('DB error'))

      await expect(recordActivity(VALID_USER_ID)).resolves.toBeUndefined()
    })
  })

  describe('updateStreak', () => {
    function setupUser(overrides: Record<string, unknown> = {}) {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            currentStreak: 5,
            longestStreak: 10,
            lastSessionDate: new Date('2026-03-15'),
            streakFreezeAvailable: 0,
            ...overrides,
          }),
        }),
      })
      mockUserUpdateOne.mockResolvedValue({})
    }

    it('increments streak when yesterday was active', async () => {
      setupUser({ currentStreak: 5 })
      // Today has activity
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' }) // today
        .mockResolvedValueOnce({ date: '2026-03-15', type: 'active' }) // yesterday

      const result = await updateStreak(VALID_USER_ID)

      expect(result.currentStreak).toBe(6)
      expect(result.frozeToday).toBe(false)
    })

    it('uses freeze when yesterday was not active but freeze available', async () => {
      setupUser({ currentStreak: 5, streakFreezeAvailable: 1 })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' }) // today
        .mockResolvedValueOnce(null) // yesterday - no activity
      mockStreakDayUpdateOne.mockResolvedValue({})

      const result = await updateStreak(VALID_USER_ID)

      expect(result.currentStreak).toBe(6)
      expect(result.frozeToday).toBe(true)
      // Should have created freeze day for yesterday
      expect(mockStreakDayUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-03-15' }),
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ type: 'freeze' }),
        }),
        { upsert: true },
      )
      // Should decrement freeze count
      expect(mockUserUpdateOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $inc: { streakFreezeAvailable: -1 } }),
      )
    })

    it('resets streak to 1 when no yesterday activity and no freeze', async () => {
      setupUser({ currentStreak: 5, streakFreezeAvailable: 0 })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' }) // today
        .mockResolvedValueOnce(null) // yesterday - no activity

      const result = await updateStreak(VALID_USER_ID)

      expect(result.currentStreak).toBe(1)
      expect(result.frozeToday).toBe(false)
    })

    it('updates longestStreak when current exceeds it', async () => {
      setupUser({ currentStreak: 10, longestStreak: 10 })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' })
        .mockResolvedValueOnce({ date: '2026-03-15', type: 'active' })

      const result = await updateStreak(VALID_USER_ID)

      expect(result.currentStreak).toBe(11)
      expect(result.longestStreak).toBe(11)
    })

    it('returns default when feature flag disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const result = await updateStreak(VALID_USER_ID)

      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })

    it('returns default when user not found', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      })

      const result = await updateStreak(VALID_USER_ID)

      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })

    it('returns default when no activity today', async () => {
      setupUser()
      mockStreakDayFindOne.mockResolvedValue(null) // no today activity

      const result = await updateStreak(VALID_USER_ID)

      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })

    it('handles first ever activity (streak 0 -> 1)', async () => {
      setupUser({ currentStreak: 0, longestStreak: 0 })
      mockStreakDayFindOne
        .mockResolvedValueOnce({ date: '2026-03-16', type: 'active' })
        .mockResolvedValueOnce(null) // no yesterday

      const result = await updateStreak(VALID_USER_ID)

      expect(result.currentStreak).toBe(1)
    })

    it('handles DB error gracefully', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      })

      const result = await updateStreak(VALID_USER_ID)

      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, frozeToday: false })
    })
  })

  describe('getStreakCalendar', () => {
    it('returns streak days for past N days', async () => {
      const days = [
        { date: '2026-03-16', type: 'active', activities: 2 },
        { date: '2026-03-15', type: 'active', activities: 1 },
      ]
      mockStreakDayFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(days),
          }),
        }),
      })

      const result = await getStreakCalendar(VALID_USER_ID, 7)

      expect(result).toHaveLength(2)
      expect(result[0].date).toBe('2026-03-16')
      expect(result[0].type).toBe('active')
    })

    it('returns empty array on error', async () => {
      mockStreakDayFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      })

      const result = await getStreakCalendar(VALID_USER_ID)
      expect(result).toEqual([])
    })
  })

  describe('getStreakLeaderboard', () => {
    it('returns top users by current streak', async () => {
      mockUserFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([
                { name: 'Alice', currentStreak: 15, level: 5 },
                { name: 'Bob', currentStreak: 10, level: 3 },
              ]),
            }),
          }),
        }),
      })

      const result = await getStreakLeaderboard(20)

      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('Alice')
      expect(result[0].currentStreak).toBe(15)
    })

    it('returns empty array on error', async () => {
      mockUserFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockRejectedValue(new Error('DB error')),
            }),
          }),
        }),
      })

      const result = await getStreakLeaderboard()
      expect(result).toEqual([])
    })
  })

  describe('refreshWeeklyFreeze', () => {
    it('sets streakFreezeAvailable to 1', async () => {
      mockUserUpdateOne.mockResolvedValue({})

      await refreshWeeklyFreeze(VALID_USER_ID)

      expect(mockUserUpdateOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ streakFreezeAvailable: 1 }),
      )
    })

    it('handles DB error gracefully', async () => {
      mockUserUpdateOne.mockRejectedValue(new Error('DB error'))

      await expect(refreshWeeklyFreeze(VALID_USER_ID)).resolves.toBeUndefined()
    })
  })
})
