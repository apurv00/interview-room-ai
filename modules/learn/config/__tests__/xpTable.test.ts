import { describe, it, expect } from 'vitest'
import { calculateLevel, getLevelTitle, XP_AMOUNTS, BADGE_XP, LEVEL_TITLES } from '../xpTable'

describe('xpTable', () => {
  describe('XP_AMOUNTS constants', () => {
    it('has correct XP values for each activity type', () => {
      expect(XP_AMOUNTS.interview_complete).toBe(50)
      expect(XP_AMOUNTS.drill_complete).toBe(10)
      expect(XP_AMOUNTS.daily_challenge).toBe(25)
      expect(XP_AMOUNTS.daily_challenge_top_quartile_bonus).toBe(10)
      expect(XP_AMOUNTS.pathway_task).toBe(15)
      expect(XP_AMOUNTS.streak_bonus_per_day).toBe(5)
      expect(XP_AMOUNTS.streak_bonus_cap).toBe(30)
    })

    it('all XP amounts are positive integers', () => {
      for (const [, value] of Object.entries(XP_AMOUNTS)) {
        expect(value).toBeGreaterThan(0)
        expect(Number.isInteger(value)).toBe(true)
      }
    })
  })

  describe('BADGE_XP constants', () => {
    it('has correct XP rewards per rarity', () => {
      expect(BADGE_XP.common).toBe(10)
      expect(BADGE_XP.rare).toBe(25)
      expect(BADGE_XP.epic).toBe(50)
      expect(BADGE_XP.legendary).toBe(100)
    })

    it('rewards are monotonically increasing by rarity', () => {
      expect(BADGE_XP.common).toBeLessThan(BADGE_XP.rare)
      expect(BADGE_XP.rare).toBeLessThan(BADGE_XP.epic)
      expect(BADGE_XP.epic).toBeLessThan(BADGE_XP.legendary)
    })
  })

  describe('LEVEL_TITLES', () => {
    it('has 11 titles from Novice to Grandmaster', () => {
      expect(LEVEL_TITLES).toHaveLength(11)
      expect(LEVEL_TITLES[0]).toBe('Novice')
      expect(LEVEL_TITLES[10]).toBe('Grandmaster')
    })
  })

  describe('calculateLevel', () => {
    it('returns level 1 for 0 XP', () => {
      const result = calculateLevel(0)
      expect(result.level).toBe(1)
      expect(result.title).toBe('Novice')
      expect(result.xpForCurrentLevel).toBe(0)
      expect(result.xpForNextLevel).toBe(100)
    })

    it('returns level 2 at exactly 100 XP', () => {
      const result = calculateLevel(100)
      expect(result.level).toBe(2)
      expect(result.title).toBe('Beginner')
    })

    it('stays level 1 at 99 XP', () => {
      const result = calculateLevel(99)
      expect(result.level).toBe(1)
    })

    it('returns level 3 at 400 XP (sqrt(4) + 1 = 3)', () => {
      const result = calculateLevel(400)
      expect(result.level).toBe(3)
      expect(result.title).toBe('Apprentice')
      expect(result.xpForCurrentLevel).toBe(400)
      expect(result.xpForNextLevel).toBe(900)
    })

    it('returns level 5 at 1600 XP', () => {
      const result = calculateLevel(1600)
      expect(result.level).toBe(5)
      expect(result.title).toBe('Intermediate')
    })

    it('returns level 10 at 8100 XP', () => {
      const result = calculateLevel(8100)
      expect(result.level).toBe(10)
      expect(result.title).toBe('Master')
    })

    it('returns level 11 at 10000 XP (sqrt(100) + 1)', () => {
      const result = calculateLevel(10000)
      expect(result.level).toBe(11)
      expect(result.title).toBe('Grandmaster')
    })

    it('caps title at Grandmaster for very high levels', () => {
      const result = calculateLevel(999999)
      expect(result.level).toBeGreaterThan(11)
      expect(result.title).toBe('Grandmaster')
    })

    it('handles negative XP gracefully (floor of NaN/negative sqrt)', () => {
      const result = calculateLevel(-100)
      // Math.sqrt(-1) = NaN, Math.floor(NaN) = NaN, NaN + 1 = NaN
      // In practice this returns NaN level, but the function should still not throw
      expect(() => calculateLevel(-100)).not.toThrow()
    })

    it('returns correct xpForCurrentLevel and xpForNextLevel boundaries', () => {
      const result = calculateLevel(500) // Level 3 (sqrt(5) = 2.23, floor = 2, +1 = 3)
      expect(result.xpForCurrentLevel).toBe(400) // (3-1)^2 * 100
      expect(result.xpForNextLevel).toBe(900)     // 3^2 * 100
    })

    it('level boundaries are monotonically increasing', () => {
      let prevLevel = 0
      for (const xp of [0, 100, 400, 900, 1600, 2500, 3600, 4900, 6400, 8100, 10000]) {
        const result = calculateLevel(xp)
        expect(result.level).toBeGreaterThan(prevLevel)
        prevLevel = result.level
      }
    })
  })

  describe('getLevelTitle', () => {
    it('returns Novice for level 1', () => {
      expect(getLevelTitle(1)).toBe('Novice')
    })

    it('returns Grandmaster for level 11', () => {
      expect(getLevelTitle(11)).toBe('Grandmaster')
    })

    it('returns correct titles for all levels 1-11', () => {
      const expected = ['Novice', 'Beginner', 'Apprentice', 'Practitioner', 'Intermediate',
        'Proficient', 'Skilled', 'Advanced', 'Expert', 'Master', 'Grandmaster']
      for (let i = 1; i <= 11; i++) {
        expect(getLevelTitle(i)).toBe(expected[i - 1])
      }
    })

    it('returns Novice for level 0 or below', () => {
      expect(getLevelTitle(0)).toBe('Novice')
      expect(getLevelTitle(-5)).toBe('Novice')
    })

    it('returns Grandmaster for levels above 11', () => {
      expect(getLevelTitle(12)).toBe('Grandmaster')
      expect(getLevelTitle(99)).toBe('Grandmaster')
    })
  })
})
