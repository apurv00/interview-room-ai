import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockFindOneAndUpdate = vi.fn()
vi.mock('@shared/db/models', () => ({
  UserCompetencyState: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@learn/services/pathwayEvents', () => ({
  emitPathwayEvent: (...args: unknown[]) => mockEmit(...args),
}))

import { updateMasteryTracking, updateMasteryBatch } from '../services/masteryTracker'
import { MASTERY_SCORE_TARGET, MASTERY_CONSECUTIVE_THRESHOLD } from '../services/phaseAdvancement'

describe('masteryTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('updateMasteryTracking', () => {
    it('returns null if no state exists for competency', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null)
      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)
      expect(result).toBeNull()
    })

    it('increments streak atomically when score meets target', async () => {
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: 2,
        masteredAt: undefined,
      })

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', MASTERY_SCORE_TARGET)

      expect(result).toEqual({
        competencyName: 'specificity',
        previousStreak: 2,
        newStreak: 3,
        newlyMastered: false,
      })
      expect(mockFindOneAndUpdate).toHaveBeenCalledOnce()
      const [, update] = mockFindOneAndUpdate.mock.calls[0]
      expect(update).toEqual({ $inc: { consecutiveAtTarget: 1 } })
    })

    it('resets streak to 0 atomically when score drops below target', async () => {
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: 4,
        masteredAt: undefined,
      })

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'ownership', MASTERY_SCORE_TARGET - 5)

      expect(result?.newStreak).toBe(0)
      const [, update] = mockFindOneAndUpdate.mock.calls[0]
      expect(update).toEqual({ $set: { consecutiveAtTarget: 0 } })
    })

    it('emits competency_mastered when crossing threshold', async () => {
      // First call: atomic $inc, returns previous doc with streak at threshold - 1
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: MASTERY_CONSECUTIVE_THRESHOLD - 1,
        masteredAt: undefined,
      })
      // Second call: conditional masteredAt set succeeds (returns doc)
      mockFindOneAndUpdate.mockResolvedValueOnce({ masteredAt: new Date() })

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'structure', 90)

      expect(result?.newlyMastered).toBe(true)
      expect(mockEmit).toHaveBeenCalledOnce()
      const [event] = mockEmit.mock.calls[0]
      expect(event.type).toBe('competency_mastered')
      expect(event.userId).toBe('507f1f77bcf86cd799439011')
      expect(event.payload.competencyName).toBe('structure')
      expect(event.payload.consecutiveAtTarget).toBe(MASTERY_CONSECUTIVE_THRESHOLD)
    })

    it('does NOT re-emit when already mastered', async () => {
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: MASTERY_CONSECUTIVE_THRESHOLD + 2,
        masteredAt: new Date('2026-01-01'),
      })

      await updateMasteryTracking('507f1f77bcf86cd799439011', 'relevance', 85)

      expect(mockFindOneAndUpdate).toHaveBeenCalledOnce()
      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('does NOT emit on non-crossing increments', async () => {
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: 2,
        masteredAt: undefined,
      })

      await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)

      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('prevents duplicate mastery events via conditional update', async () => {
      // Streak at threshold - 1, first thread increments
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: MASTERY_CONSECUTIVE_THRESHOLD - 1,
        masteredAt: undefined,
      })
      // Conditional masteredAt set fails (another thread already set it)
      mockFindOneAndUpdate.mockResolvedValueOnce(null)

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'structure', 90)

      expect(result?.newlyMastered).toBe(false)
      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('handles errors gracefully (returns null)', async () => {
      mockFindOneAndUpdate.mockRejectedValue(new Error('db exploded'))
      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)
      expect(result).toBeNull()
    })
  })

  describe('updateMasteryBatch', () => {
    it('updates multiple competencies and returns results', async () => {
      // specificity: score 80 >= 75, increment
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: 0,
        masteredAt: undefined,
      })
      // ownership: score 60 < 75, reset
      mockFindOneAndUpdate.mockResolvedValueOnce({
        consecutiveAtTarget: 1,
        masteredAt: undefined,
      })

      const results = await updateMasteryBatch('507f1f77bcf86cd799439011', {
        specificity: 80,
        ownership: 60,
      })

      expect(results).toHaveLength(2)
      expect(results[0].newStreak).toBe(1)
      expect(results[1].newStreak).toBe(0)
    })

    it('skips missing competency states', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null)
      const results = await updateMasteryBatch('507f1f77bcf86cd799439011', { unknown: 80 })
      expect(results).toHaveLength(0)
    })
  })
})
