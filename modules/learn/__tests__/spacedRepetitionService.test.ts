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

vi.mock('@shared/db/models', () => ({
  UserCompetencyState: {
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
  },
}))

import { scoreToQuality, calculateNextReview } from '@learn/services/spacedRepetitionService'

describe('spacedRepetitionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('scoreToQuality', () => {
    it('maps scores to SM-2 quality levels', () => {
      expect(scoreToQuality(90)).toBe(5)
      expect(scoreToQuality(80)).toBe(4)
      expect(scoreToQuality(70)).toBe(3)
      expect(scoreToQuality(60)).toBe(2)
      expect(scoreToQuality(45)).toBe(1)
      expect(scoreToQuality(30)).toBe(0)
    })

    it('handles boundary values', () => {
      expect(scoreToQuality(86)).toBe(5)
      expect(scoreToQuality(85)).toBe(4)
      expect(scoreToQuality(76)).toBe(4)
      expect(scoreToQuality(75)).toBe(3)
      expect(scoreToQuality(66)).toBe(3)
      expect(scoreToQuality(65)).toBe(2)
      expect(scoreToQuality(56)).toBe(2)
      expect(scoreToQuality(55)).toBe(1)
      expect(scoreToQuality(41)).toBe(1)
      expect(scoreToQuality(40)).toBe(0)
      expect(scoreToQuality(0)).toBe(0)
      expect(scoreToQuality(100)).toBe(5)
    })
  })

  describe('calculateNextReview', () => {
    it('sets interval=1 for first successful review', () => {
      const result = calculateNextReview({
        quality: 4,
        repetitionCount: 0,
        interval: 1,
        easeFactor: 2.5,
      })

      expect(result.interval).toBe(1)
      expect(result.repetitionCount).toBe(1)
    })

    it('sets interval=3 for second successful review', () => {
      const result = calculateNextReview({
        quality: 4,
        repetitionCount: 1,
        interval: 1,
        easeFactor: 2.5,
      })

      expect(result.interval).toBe(3)
      expect(result.repetitionCount).toBe(2)
    })

    it('multiplies interval by easeFactor for subsequent reviews', () => {
      const result = calculateNextReview({
        quality: 4,
        repetitionCount: 2,
        interval: 3,
        easeFactor: 2.5,
      })

      expect(result.interval).toBe(8) // round(3 * 2.5) = 8
      expect(result.repetitionCount).toBe(3)
    })

    it('resets on failed review (quality < 3)', () => {
      const result = calculateNextReview({
        quality: 2,
        repetitionCount: 5,
        interval: 30,
        easeFactor: 2.5,
      })

      expect(result.interval).toBe(1)
      expect(result.repetitionCount).toBe(0)
    })

    it('never lets easeFactor drop below 1.3', () => {
      const result = calculateNextReview({
        quality: 0,
        repetitionCount: 0,
        interval: 1,
        easeFactor: 1.3,
      })

      expect(result.easeFactor).toBeGreaterThanOrEqual(1.3)
    })

    it('increases easeFactor for high quality responses', () => {
      const result = calculateNextReview({
        quality: 5,
        repetitionCount: 2,
        interval: 3,
        easeFactor: 2.5,
      })

      expect(result.easeFactor).toBeGreaterThan(2.5)
    })

    it('decreases easeFactor for low quality but passing responses', () => {
      const result = calculateNextReview({
        quality: 3,
        repetitionCount: 2,
        interval: 3,
        easeFactor: 2.5,
      })

      expect(result.easeFactor).toBeLessThan(2.5)
    })

    it('sets nextReviewAt in the future', () => {
      const now = Date.now()
      const result = calculateNextReview({
        quality: 4,
        repetitionCount: 0,
        interval: 1,
        easeFactor: 2.5,
      })

      expect(result.nextReviewAt.getTime()).toBeGreaterThan(now)
    })
  })
})
