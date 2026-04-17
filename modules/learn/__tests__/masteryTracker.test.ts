import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockFindOne = vi.fn()
vi.mock('@shared/db/models', () => ({
  UserCompetencyState: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
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

  const makeState = (overrides: Record<string, unknown> = {}) => {
    const save = vi.fn().mockResolvedValue(undefined)
    return {
      consecutiveAtTarget: 0,
      masteredAt: undefined,
      save,
      ...overrides,
    }
  }

  describe('updateMasteryTracking', () => {
    it('returns null if no state exists for competency', async () => {
      mockFindOne.mockResolvedValue(null)
      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)
      expect(result).toBeNull()
    })

    it('increments streak when score meets target', async () => {
      const state = makeState({ consecutiveAtTarget: 2 })
      mockFindOne.mockResolvedValue(state)

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', MASTERY_SCORE_TARGET)

      expect(result).toEqual({
        competencyName: 'specificity',
        previousStreak: 2,
        newStreak: 3,
        newlyMastered: false,
      })
      expect(state.consecutiveAtTarget).toBe(3)
      expect(state.save).toHaveBeenCalledOnce()
    })

    it('resets streak to 0 when score drops below target', async () => {
      const state = makeState({ consecutiveAtTarget: 4 })
      mockFindOne.mockResolvedValue(state)

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'ownership', MASTERY_SCORE_TARGET - 5)

      expect(result?.newStreak).toBe(0)
      expect(state.consecutiveAtTarget).toBe(0)
    })

    it('emits competency_mastered when crossing threshold', async () => {
      const state = makeState({ consecutiveAtTarget: MASTERY_CONSECUTIVE_THRESHOLD - 1 })
      mockFindOne.mockResolvedValue(state)

      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'structure', 90)

      expect(result?.newlyMastered).toBe(true)
      expect(state.masteredAt).toBeInstanceOf(Date)
      expect(mockEmit).toHaveBeenCalledOnce()
      const [event] = mockEmit.mock.calls[0]
      expect(event.type).toBe('competency_mastered')
      expect(event.userId).toBe('507f1f77bcf86cd799439011')
      expect(event.payload.competencyName).toBe('structure')
      expect(event.payload.consecutiveAtTarget).toBe(MASTERY_CONSECUTIVE_THRESHOLD)
    })

    it('does NOT re-emit when already mastered', async () => {
      const state = makeState({
        consecutiveAtTarget: MASTERY_CONSECUTIVE_THRESHOLD + 2,
        masteredAt: new Date('2026-01-01'),
      })
      mockFindOne.mockResolvedValue(state)

      await updateMasteryTracking('507f1f77bcf86cd799439011', 'relevance', 85)

      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('does NOT emit on non-crossing increments', async () => {
      const state = makeState({ consecutiveAtTarget: 2 })
      mockFindOne.mockResolvedValue(state)

      await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)

      expect(mockEmit).not.toHaveBeenCalled()
    })

    it('handles errors gracefully (returns null)', async () => {
      mockFindOne.mockRejectedValue(new Error('db exploded'))
      const result = await updateMasteryTracking('507f1f77bcf86cd799439011', 'specificity', 80)
      expect(result).toBeNull()
    })
  })

  describe('updateMasteryBatch', () => {
    it('updates multiple competencies and returns results', async () => {
      const state1 = makeState({ consecutiveAtTarget: 0 })
      const state2 = makeState({ consecutiveAtTarget: 1 })
      mockFindOne
        .mockResolvedValueOnce(state1)
        .mockResolvedValueOnce(state2)

      const results = await updateMasteryBatch('507f1f77bcf86cd799439011', {
        specificity: 80,
        ownership: 60,
      })

      expect(results).toHaveLength(2)
      expect(results[0].newStreak).toBe(1) // hit target
      expect(results[1].newStreak).toBe(0) // reset
    })

    it('skips missing competency states', async () => {
      mockFindOne.mockResolvedValue(null)
      const results = await updateMasteryBatch('507f1f77bcf86cd799439011', { unknown: 80 })
      expect(results).toHaveLength(0)
    })
  })
})
