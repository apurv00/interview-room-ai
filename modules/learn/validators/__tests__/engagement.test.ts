import { describe, it, expect } from 'vitest'
import { SubmitDailyChallengeSchema, BadgeNotifySchema, XpHistoryQuerySchema } from '../engagement'

describe('engagement validators', () => {
  describe('SubmitDailyChallengeSchema', () => {
    it('accepts valid answer (50 chars)', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 'A'.repeat(50) })
      expect(result.success).toBe(true)
    })

    it('accepts answer at minimum length (10 chars)', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 'A'.repeat(10) })
      expect(result.success).toBe(true)
    })

    it('accepts answer at maximum length (5000 chars)', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 'A'.repeat(5000) })
      expect(result.success).toBe(true)
    })

    it('rejects answer shorter than 10 chars', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 'short' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 10 characters')
      }
    })

    it('rejects answer longer than 5000 chars', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 'A'.repeat(5001) })
      expect(result.success).toBe(false)
    })

    it('rejects empty string', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: '' })
      expect(result.success).toBe(false)
    })

    it('rejects missing answer field', () => {
      const result = SubmitDailyChallengeSchema.safeParse({})
      expect(result.success).toBe(false)
    })

    it('rejects non-string answer', () => {
      const result = SubmitDailyChallengeSchema.safeParse({ answer: 123 })
      expect(result.success).toBe(false)
    })
  })

  describe('BadgeNotifySchema', () => {
    it('accepts valid badgeId string', () => {
      const result = BadgeNotifySchema.safeParse({ badgeId: 'first_interview' })
      expect(result.success).toBe(true)
    })

    it('rejects empty string', () => {
      const result = BadgeNotifySchema.safeParse({ badgeId: '' })
      expect(result.success).toBe(false)
    })

    it('rejects string over 50 chars', () => {
      const result = BadgeNotifySchema.safeParse({ badgeId: 'x'.repeat(51) })
      expect(result.success).toBe(false)
    })

    it('rejects missing badgeId', () => {
      const result = BadgeNotifySchema.safeParse({})
      expect(result.success).toBe(false)
    })

    it('rejects non-string badgeId', () => {
      const result = BadgeNotifySchema.safeParse({ badgeId: 42 })
      expect(result.success).toBe(false)
    })
  })

  describe('XpHistoryQuerySchema', () => {
    it('defaults limit to 20 when not provided', () => {
      const result = XpHistoryQuerySchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(20)
      }
    })

    it('accepts limit of 1 (minimum)', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: 1 })
      expect(result.success).toBe(true)
    })

    it('accepts limit of 100 (maximum)', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: 100 })
      expect(result.success).toBe(true)
    })

    it('rejects limit of 0 (below minimum)', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: 0 })
      expect(result.success).toBe(false)
    })

    it('rejects limit of 101 (above maximum)', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: 101 })
      expect(result.success).toBe(false)
    })

    it('coerces string limit to number', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: '50' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(50)
      }
    })

    it('accepts limit of 50', () => {
      const result = XpHistoryQuerySchema.safeParse({ limit: 50 })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(50)
      }
    })
  })
})
