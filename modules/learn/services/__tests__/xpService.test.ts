import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before imports
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockXpEventCreate = vi.fn()
const mockUserFindByIdAndUpdate = vi.fn()
const mockUserUpdateOne = vi.fn()
const mockUserFindById = vi.fn()
const mockXpEventFind = vi.fn()

vi.mock('@shared/db/models/XpEvent', () => ({
  XpEvent: {
    create: (...args: unknown[]) => mockXpEventCreate(...args),
    find: (...args: unknown[]) => mockXpEventFind(...args),
  },
}))

vi.mock('@shared/db/models/User', () => ({
  User: {
    findByIdAndUpdate: (...args: unknown[]) => mockUserFindByIdAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUserUpdateOne(...args),
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}))

import { awardXp, getXpSummary, getXpHistory } from '../xpService'
import { isFeatureEnabled } from '@shared/featureFlags'

const VALID_USER_ID = '507f1f77bcf86cd799439011'

describe('xpService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  describe('awardXp', () => {
    it('creates XpEvent and increments user XP atomically', async () => {
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })
      mockUserUpdateOne.mockResolvedValue({})

      const result = await awardXp(VALID_USER_ID, 'interview_complete', 50)

      expect(mockXpEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'interview_complete', amount: 50 }),
      )
      expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $inc: { xp: 50, xpThisWeek: 50 } },
        { new: true, select: 'xp level' },
      )
      expect(result.newXp).toBe(50)
    })

    it('returns leveledUp: true when crossing level boundary', async () => {
      mockXpEventCreate.mockResolvedValue({})
      // User was level 1, now has 100 XP -> level 2
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 100, level: 1 })
      mockUserUpdateOne.mockResolvedValue({})

      const result = await awardXp(VALID_USER_ID, 'interview_complete', 50)

      expect(result.leveledUp).toBe(true)
      expect(result.newLevel).toBe(2)
      expect(result.title).toBe('Beginner')
      // Should update level in DB
      expect(mockUserUpdateOne).toHaveBeenCalled()
    })

    it('returns leveledUp: false when staying same level', async () => {
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })

      const result = await awardXp(VALID_USER_ID, 'drill_complete', 10)

      expect(result.leveledUp).toBe(false)
      expect(result.newLevel).toBe(1)
    })

    it('returns default when feature flag is disabled', async () => {
      ;(isFeatureEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const result = await awardXp(VALID_USER_ID, 'interview_complete', 50)

      expect(result).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })
      expect(mockXpEventCreate).not.toHaveBeenCalled()
      expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled()
    })

    it('returns default when user not found', async () => {
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue(null)

      const result = await awardXp(VALID_USER_ID, 'interview_complete', 50)

      expect(result).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })
    })

    it('handles DB errors gracefully', async () => {
      mockXpEventCreate.mockRejectedValue(new Error('DB error'))

      const result = await awardXp(VALID_USER_ID, 'interview_complete', 50)

      expect(result).toEqual({ newXp: 0, newLevel: 1, leveledUp: false, title: 'Novice' })
    })

    it('stores metadata in XpEvent', async () => {
      mockXpEventCreate.mockResolvedValue({})
      mockUserFindByIdAndUpdate.mockResolvedValue({ xp: 50, level: 1 })

      await awardXp(VALID_USER_ID, 'interview_complete', 50, { sessionId: 'abc123' })

      expect(mockXpEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { sessionId: 'abc123' } }),
      )
    })
  })

  describe('getXpSummary', () => {
    it('returns correct summary for user with XP', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ xp: 500, level: 3, xpThisWeek: 100 }),
        }),
      })

      const result = await getXpSummary(VALID_USER_ID)

      expect(result.xp).toBe(500)
      expect(result.level).toBe(3) // sqrt(500/100)=2.23, floor+1=3
      expect(result.title).toBe('Apprentice')
      expect(result.xpThisWeek).toBe(100)
      expect(result.xpForCurrentLevel).toBe(400) // (3-1)^2 * 100
      expect(result.xpForNextLevel).toBe(900)    // 3^2 * 100
      expect(result.xpToNextLevel).toBe(400)     // 900 - 500
    })

    it('returns default when user not found', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      })

      const result = await getXpSummary(VALID_USER_ID)

      expect(result).toEqual({
        xp: 0, level: 1, title: 'Novice',
        xpToNextLevel: 100, xpThisWeek: 0,
        xpForCurrentLevel: 0, xpForNextLevel: 100,
      })
    })

    it('handles DB errors gracefully', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      })

      const result = await getXpSummary(VALID_USER_ID)

      expect(result.xp).toBe(0)
      expect(result.level).toBe(1)
    })

    it('defaults xpThisWeek to 0 when undefined', async () => {
      mockUserFindById.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ xp: 100, level: 2 }),
        }),
      })

      const result = await getXpSummary(VALID_USER_ID)
      expect(result.xpThisWeek).toBe(0)
    })
  })

  describe('getXpHistory', () => {
    it('returns XP events sorted by date', async () => {
      const events = [
        { type: 'interview_complete', amount: 50, metadata: {}, createdAt: new Date('2026-03-16') },
        { type: 'drill_complete', amount: 10, metadata: {}, createdAt: new Date('2026-03-15') },
      ]
      mockXpEventFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue(events),
            }),
          }),
        }),
      })

      const result = await getXpHistory(VALID_USER_ID)

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('interview_complete')
      expect(result[0].amount).toBe(50)
    })

    it('returns empty array on error', async () => {
      mockXpEventFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockRejectedValue(new Error('DB error')),
            }),
          }),
        }),
      })

      const result = await getXpHistory(VALID_USER_ID)
      expect(result).toEqual([])
    })

    it('returns empty array when no events exist', async () => {
      mockXpEventFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      })

      const result = await getXpHistory(VALID_USER_ID)
      expect(result).toEqual([])
    })

    it('defaults metadata to empty object when undefined', async () => {
      mockXpEventFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([
                { type: 'drill_complete', amount: 10, createdAt: new Date() },
              ]),
            }),
          }),
        }),
      })

      const result = await getXpHistory(VALID_USER_ID)
      expect(result[0].metadata).toEqual({})
    })
  })
})
