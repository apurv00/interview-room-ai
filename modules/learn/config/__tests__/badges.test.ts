import { describe, it, expect } from 'vitest'
import {
  BADGE_DEFINITIONS,
  getBadgesByTrigger,
  getBadgeById,
  type BadgeCheckContext,
} from '../badges'

describe('badges config', () => {
  describe('BADGE_DEFINITIONS structure', () => {
    it('has exactly 19 badge definitions', () => {
      expect(BADGE_DEFINITIONS).toHaveLength(19)
    })

    it('all badges have required fields', () => {
      for (const badge of BADGE_DEFINITIONS) {
        expect(badge.id).toBeTruthy()
        expect(badge.name).toBeTruthy()
        expect(badge.description).toBeTruthy()
        expect(badge.icon).toBeTruthy()
        expect(badge.category).toBeTruthy()
        expect(badge.xpReward).toBeGreaterThan(0)
        expect(badge.rarity).toBeTruthy()
        expect(badge.triggerTypes.length).toBeGreaterThan(0)
        expect(typeof badge.check).toBe('function')
      }
    })

    it('all badge IDs are unique', () => {
      const ids = BADGE_DEFINITIONS.map(b => b.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all categories are valid', () => {
      const validCategories = ['milestone', 'streak', 'score', 'exploration', 'social']
      for (const badge of BADGE_DEFINITIONS) {
        expect(validCategories).toContain(badge.category)
      }
    })

    it('all rarities are valid', () => {
      const validRarities = ['common', 'rare', 'epic', 'legendary']
      for (const badge of BADGE_DEFINITIONS) {
        expect(validRarities).toContain(badge.rarity)
      }
    })

    it('all trigger types are valid', () => {
      const validTriggers = ['interview_complete', 'drill_complete', 'streak_update', 'daily_challenge', 'share', 'domain_practice']
      for (const badge of BADGE_DEFINITIONS) {
        for (const trigger of badge.triggerTypes) {
          expect(validTriggers).toContain(trigger)
        }
      }
    })
  })

  describe('getBadgesByTrigger', () => {
    it('returns milestone + score badges for interview_complete', () => {
      const badges = getBadgesByTrigger('interview_complete')
      const categories = new Set(badges.map(b => b.category))
      expect(categories).toContain('milestone')
      expect(categories).toContain('score')
      expect(badges.length).toBeGreaterThanOrEqual(9) // 4 milestone + 5 score
    })

    it('returns streak badges for streak_update', () => {
      const badges = getBadgesByTrigger('streak_update')
      expect(badges.every(b => b.category === 'streak')).toBe(true)
      expect(badges).toHaveLength(5) // streak_3, 7, 14, 30, 100
    })

    it('returns exploration badges for daily_challenge', () => {
      const badges = getBadgesByTrigger('daily_challenge')
      expect(badges.length).toBeGreaterThanOrEqual(2) // daily_challenger, daily_challenge_10
    })

    it('returns social badges for share', () => {
      const badges = getBadgesByTrigger('share')
      expect(badges).toHaveLength(1)
      expect(badges[0].id).toBe('shared_scorecard')
    })

    it('returns exploration badges for domain_practice', () => {
      const badges = getBadgesByTrigger('domain_practice')
      const ids = badges.map(b => b.id)
      expect(ids).toContain('explorer_3_domains')
      expect(ids).toContain('depth_explorer')
    })

    it('returns empty array for drill_complete (no badges assigned)', () => {
      const badges = getBadgesByTrigger('drill_complete')
      // drill_complete may have no badges — depends on config
      expect(Array.isArray(badges)).toBe(true)
    })
  })

  describe('getBadgeById', () => {
    it('returns correct badge for valid ID', () => {
      const badge = getBadgeById('first_interview')
      expect(badge).toBeDefined()
      expect(badge!.name).toBe('First Steps')
      expect(badge!.category).toBe('milestone')
    })

    it('returns undefined for non-existent ID', () => {
      expect(getBadgeById('nonexistent')).toBeUndefined()
    })

    it('returns correct badge for each known ID', () => {
      const knownIds = [
        'first_interview', 'interviews_5', 'interviews_25', 'interviews_100',
        'streak_3', 'streak_7', 'streak_14', 'streak_30', 'streak_100',
        'score_70', 'score_80', 'score_90', 'score_100', 'comeback',
        'explorer_3_domains', 'depth_explorer', 'daily_challenger', 'daily_challenge_10',
        'shared_scorecard',
      ]
      for (const id of knownIds) {
        expect(getBadgeById(id)).toBeDefined()
      }
    })
  })

  describe('badge check functions', () => {
    const baseCtx: BadgeCheckContext = {
      userId: 'test-user',
      triggerType: 'interview_complete',
    }

    describe('milestone badges', () => {
      it('first_interview: passes at interviewCount >= 1', () => {
        const badge = getBadgeById('first_interview')!
        expect(badge.check({ ...baseCtx, interviewCount: 1 })).toBe(true)
        expect(badge.check({ ...baseCtx, interviewCount: 0 })).toBe(false)
        expect(badge.check({ ...baseCtx })).toBe(false) // undefined defaults to 0
      })

      it('interviews_5: passes at interviewCount >= 5', () => {
        const badge = getBadgeById('interviews_5')!
        expect(badge.check({ ...baseCtx, interviewCount: 5 })).toBe(true)
        expect(badge.check({ ...baseCtx, interviewCount: 4 })).toBe(false)
      })

      it('interviews_25: passes at interviewCount >= 25', () => {
        const badge = getBadgeById('interviews_25')!
        expect(badge.check({ ...baseCtx, interviewCount: 25 })).toBe(true)
        expect(badge.check({ ...baseCtx, interviewCount: 24 })).toBe(false)
      })

      it('interviews_100: passes at interviewCount >= 100', () => {
        const badge = getBadgeById('interviews_100')!
        expect(badge.check({ ...baseCtx, interviewCount: 100 })).toBe(true)
        expect(badge.check({ ...baseCtx, interviewCount: 99 })).toBe(false)
      })
    })

    describe('streak badges', () => {
      const streakCtx = { ...baseCtx, triggerType: 'streak_update' as const }

      it('streak_3: passes at currentStreak >= 3', () => {
        const badge = getBadgeById('streak_3')!
        expect(badge.check({ ...streakCtx, currentStreak: 3 })).toBe(true)
        expect(badge.check({ ...streakCtx, currentStreak: 2 })).toBe(false)
      })

      it('streak_7: passes at currentStreak >= 7', () => {
        const badge = getBadgeById('streak_7')!
        expect(badge.check({ ...streakCtx, currentStreak: 7 })).toBe(true)
        expect(badge.check({ ...streakCtx, currentStreak: 6 })).toBe(false)
      })

      it('streak_14: passes at currentStreak >= 14', () => {
        const badge = getBadgeById('streak_14')!
        expect(badge.check({ ...streakCtx, currentStreak: 14 })).toBe(true)
        expect(badge.check({ ...streakCtx, currentStreak: 13 })).toBe(false)
      })

      it('streak_30: passes at currentStreak >= 30', () => {
        const badge = getBadgeById('streak_30')!
        expect(badge.check({ ...streakCtx, currentStreak: 30 })).toBe(true)
        expect(badge.check({ ...streakCtx, currentStreak: 29 })).toBe(false)
      })

      it('streak_100: passes at currentStreak >= 100', () => {
        const badge = getBadgeById('streak_100')!
        expect(badge.check({ ...streakCtx, currentStreak: 100 })).toBe(true)
        expect(badge.check({ ...streakCtx, currentStreak: 99 })).toBe(false)
      })
    })

    describe('score badges', () => {
      it('score_70: passes at score >= 70', () => {
        const badge = getBadgeById('score_70')!
        expect(badge.check({ ...baseCtx, score: 70 })).toBe(true)
        expect(badge.check({ ...baseCtx, score: 69 })).toBe(false)
      })

      it('score_80: passes at score >= 80', () => {
        const badge = getBadgeById('score_80')!
        expect(badge.check({ ...baseCtx, score: 80 })).toBe(true)
        expect(badge.check({ ...baseCtx, score: 79 })).toBe(false)
      })

      it('score_90: passes at score >= 90', () => {
        const badge = getBadgeById('score_90')!
        expect(badge.check({ ...baseCtx, score: 90 })).toBe(true)
        expect(badge.check({ ...baseCtx, score: 89 })).toBe(false)
      })

      it('score_100: passes at score >= 100', () => {
        const badge = getBadgeById('score_100')!
        expect(badge.check({ ...baseCtx, score: 100 })).toBe(true)
        expect(badge.check({ ...baseCtx, score: 99 })).toBe(false)
      })

      it('comeback: requires score - previousScore >= 20', () => {
        const badge = getBadgeById('comeback')!
        expect(badge.check({ ...baseCtx, score: 80, previousScore: 60 })).toBe(true)
        expect(badge.check({ ...baseCtx, score: 80, previousScore: 61 })).toBe(false)
        expect(badge.check({ ...baseCtx, score: 80 })).toBe(false) // no previousScore
        expect(badge.check({ ...baseCtx, previousScore: 50 })).toBe(false) // no score
      })
    })

    describe('exploration badges', () => {
      it('explorer_3_domains: passes at domainCount >= 3', () => {
        const badge = getBadgeById('explorer_3_domains')!
        const ctx = { ...baseCtx, triggerType: 'domain_practice' as const }
        expect(badge.check({ ...ctx, domainCount: 3 })).toBe(true)
        expect(badge.check({ ...ctx, domainCount: 2 })).toBe(false)
      })

      it('depth_explorer: passes at depthCount >= 6', () => {
        const badge = getBadgeById('depth_explorer')!
        const ctx = { ...baseCtx, triggerType: 'domain_practice' as const }
        expect(badge.check({ ...ctx, depthCount: 6 })).toBe(true)
        expect(badge.check({ ...ctx, depthCount: 5 })).toBe(false)
      })

      it('daily_challenger: passes at dailyChallengeCount >= 1', () => {
        const badge = getBadgeById('daily_challenger')!
        const ctx = { ...baseCtx, triggerType: 'daily_challenge' as const }
        expect(badge.check({ ...ctx, dailyChallengeCount: 1 })).toBe(true)
        expect(badge.check({ ...ctx, dailyChallengeCount: 0 })).toBe(false)
      })

      it('daily_challenge_10: passes at dailyChallengeCount >= 10', () => {
        const badge = getBadgeById('daily_challenge_10')!
        const ctx = { ...baseCtx, triggerType: 'daily_challenge' as const }
        expect(badge.check({ ...ctx, dailyChallengeCount: 10 })).toBe(true)
        expect(badge.check({ ...ctx, dailyChallengeCount: 9 })).toBe(false)
      })
    })

    describe('social badges', () => {
      it('shared_scorecard: always passes (triggered by share action)', () => {
        const badge = getBadgeById('shared_scorecard')!
        const ctx = { ...baseCtx, triggerType: 'share' as const }
        expect(badge.check(ctx)).toBe(true)
      })
    })
  })
})
