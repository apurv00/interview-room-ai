import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateLevel, getLevelTitle, XP_AMOUNTS } from '@learn/config/xpTable'
import { BADGE_DEFINITIONS, getBadgesByTrigger, getBadgeById } from '@learn/config/badges'
import { SubmitDailyChallengeSchema } from '@learn/validators/engagement'
import type { BadgeCheckContext } from '@learn/config/badges'

/**
 * Performance tests for engagement features.
 * Tests that pure functions and lookups execute within acceptable time bounds.
 * All tests use mocked DB (no real I/O) so they measure computation, not network.
 */

describe('Engagement Performance Tests', () => {
  describe('calculateLevel performance', () => {
    it('10,000 calls complete within 50ms', () => {
      const start = performance.now()
      for (let i = 0; i < 10_000; i++) {
        calculateLevel(i * 10)
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('getLevelTitle performance', () => {
    it('10,000 calls complete within 50ms', () => {
      const start = performance.now()
      for (let i = 0; i < 10_000; i++) {
        getLevelTitle((i % 15) + 1)
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('badge check functions performance', () => {
    it('all 19 badges x 1,000 iterations complete within 100ms', () => {
      const ctx: BadgeCheckContext = {
        userId: 'test',
        triggerType: 'interview_complete',
        interviewCount: 50,
        currentStreak: 15,
        score: 85,
        previousScore: 60,
        domainCount: 5,
        depthCount: 6,
        dailyChallengeCount: 12,
      }

      const start = performance.now()
      for (let i = 0; i < 1_000; i++) {
        for (const badge of BADGE_DEFINITIONS) {
          badge.check(ctx)
        }
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('getBadgesByTrigger performance', () => {
    it('10,000 lookups complete within 50ms', () => {
      const triggers = ['interview_complete', 'streak_update', 'daily_challenge', 'share', 'domain_practice'] as const

      const start = performance.now()
      for (let i = 0; i < 10_000; i++) {
        getBadgesByTrigger(triggers[i % triggers.length])
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('getBadgeById performance', () => {
    it('10,000 lookups complete within 50ms', () => {
      const ids = BADGE_DEFINITIONS.map(b => b.id)

      const start = performance.now()
      for (let i = 0; i < 10_000; i++) {
        getBadgeById(ids[i % ids.length])
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('Zod schema validation performance', () => {
    it('1,000 SubmitDailyChallengeSchema.parse calls complete within 100ms', () => {
      const validInput = { answer: 'A detailed answer about my experience handling a difficult situation at work that required creative problem-solving.' }

      const start = performance.now()
      for (let i = 0; i < 1_000; i++) {
        SubmitDailyChallengeSchema.safeParse(validInput)
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('XP_AMOUNTS access performance', () => {
    it('100,000 constant accesses complete within 10ms', () => {
      const keys = Object.keys(XP_AMOUNTS) as (keyof typeof XP_AMOUNTS)[]
      let sum = 0

      const start = performance.now()
      for (let i = 0; i < 100_000; i++) {
        sum += XP_AMOUNTS[keys[i % keys.length]]
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(10)
      expect(sum).toBeGreaterThan(0)
    })
  })

  describe('badge definitions array iteration performance', () => {
    it('filtering all badges 1,000 times completes within 50ms', () => {
      const start = performance.now()
      for (let i = 0; i < 1_000; i++) {
        BADGE_DEFINITIONS.filter(b => b.category === 'milestone')
        BADGE_DEFINITIONS.filter(b => b.rarity === 'legendary')
        BADGE_DEFINITIONS.find(b => b.id === 'streak_30')
      }
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })
})
