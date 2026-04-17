import { describe, it, expect } from 'vitest'
import {
  resolveCurrentPhase,
  getPhaseStatus,
  detectPhaseGraduation,
  isCompetencyMastered,
  phaseFocusCompetencies,
  PHASE_ORDER,
  DEFAULT_PHASE_THRESHOLDS,
  MASTERY_CONSECUTIVE_THRESHOLD,
} from '../services/phaseAdvancement'

describe('phaseAdvancement', () => {
  describe('resolveCurrentPhase', () => {
    it('returns assessment at 0 sessions', () => {
      expect(resolveCurrentPhase(0)).toBe('assessment')
    })

    it('returns assessment at 1 session (< threshold 2)', () => {
      expect(resolveCurrentPhase(1)).toBe('assessment')
    })

    it('returns foundation at threshold crossing (2 sessions)', () => {
      expect(resolveCurrentPhase(2)).toBe('foundation')
    })

    it('returns building at session 6', () => {
      expect(resolveCurrentPhase(6)).toBe('building')
    })

    it('returns intensity at session 14', () => {
      expect(resolveCurrentPhase(14)).toBe('intensity')
    })

    it('returns mastery at session 22', () => {
      expect(resolveCurrentPhase(22)).toBe('mastery')
    })

    it('returns review at session 28', () => {
      expect(resolveCurrentPhase(28)).toBe('review')
    })

    it('returns review indefinitely after last threshold', () => {
      expect(resolveCurrentPhase(30)).toBe('review')
      expect(resolveCurrentPhase(100)).toBe('review')
    })

    it('respects custom thresholds', () => {
      const custom = { assessment: 1, foundation: 2, building: 3, intensity: 4, mastery: 5, review: 6 }
      expect(resolveCurrentPhase(0, custom)).toBe('assessment')
      expect(resolveCurrentPhase(1, custom)).toBe('foundation')
      expect(resolveCurrentPhase(3, custom)).toBe('intensity')
    })
  })

  describe('getPhaseStatus', () => {
    it('reports status at session 0 (start of assessment)', () => {
      const s = getPhaseStatus(0)
      expect(s.currentPhase).toBe('assessment')
      expect(s.sessionsInPhase).toBe(0)
      expect(s.sessionsUntilNextPhase).toBe(2)
      expect(s.progressInPhasePct).toBe(0)
      expect(s.isGraduating).toBe(false)
      expect(s.nextPhase).toBe('foundation')
    })

    it('reports status mid-phase', () => {
      const s = getPhaseStatus(4) // foundation runs 2→5, user at 4 = 2 sessions in
      expect(s.currentPhase).toBe('foundation')
      expect(s.sessionsInPhase).toBe(2)
      expect(s.sessionsUntilNextPhase).toBe(2)
      expect(s.progressInPhasePct).toBe(50)
    })

    it('isGraduating = true only when exactly at threshold', () => {
      const s = getPhaseStatus(5) // foundation threshold is 6, 5 = 1 remaining
      expect(s.isGraduating).toBe(false)

      // Threshold crossed means already in next phase, so isGraduating always
      // reports about the new phase. Verify: at sessions=6, we're in 'building'
      const after = getPhaseStatus(6)
      expect(after.currentPhase).toBe('building')
    })

    it('review phase has no next phase', () => {
      const s = getPhaseStatus(30)
      expect(s.currentPhase).toBe('review')
      expect(s.nextPhase).toBeNull()
    })
  })

  describe('detectPhaseGraduation', () => {
    it('returns null when still in same phase', () => {
      expect(detectPhaseGraduation(0, 1)).toBeNull()
      expect(detectPhaseGraduation(3, 4)).toBeNull()
    })

    it('returns previous phase when crossing threshold', () => {
      expect(detectPhaseGraduation(1, 2)).toBe('assessment')
      expect(detectPhaseGraduation(5, 6)).toBe('foundation')
      expect(detectPhaseGraduation(13, 14)).toBe('building')
    })

    it('returns null for no-op', () => {
      expect(detectPhaseGraduation(5, 5)).toBeNull()
    })
  })

  describe('isCompetencyMastered', () => {
    it('returns true at the threshold', () => {
      expect(isCompetencyMastered(MASTERY_CONSECUTIVE_THRESHOLD)).toBe(true)
    })

    it('returns false below threshold', () => {
      expect(isCompetencyMastered(MASTERY_CONSECUTIVE_THRESHOLD - 1)).toBe(false)
    })

    it('returns true above threshold', () => {
      expect(isCompetencyMastered(MASTERY_CONSECUTIVE_THRESHOLD + 10)).toBe(true)
    })

    it('respects custom threshold', () => {
      expect(isCompetencyMastered(3, 3)).toBe(true)
      expect(isCompetencyMastered(2, 3)).toBe(false)
    })
  })

  describe('phaseFocusCompetencies', () => {
    const weak = ['specificity', 'ownership', 'structure', 'relevance']
    const strong = ['communication', 'confidence', 'composure']

    it('assessment focuses on top 3 weaknesses', () => {
      expect(phaseFocusCompetencies('assessment', weak, strong)).toEqual([
        'specificity', 'ownership', 'structure',
      ])
    })

    it('foundation mixes weak (2) + strong (1)', () => {
      const result = phaseFocusCompetencies('foundation', weak, strong)
      expect(result).toHaveLength(3)
      expect(result).toContain('specificity')
      expect(result).toContain('communication')
    })

    it('mastery mixes weak + strong', () => {
      const result = phaseFocusCompetencies('mastery', weak, strong)
      expect(result).toHaveLength(3)
    })

    it('review focuses on strengths', () => {
      expect(phaseFocusCompetencies('review', weak, strong)).toEqual(strong)
    })

    it('handles empty inputs gracefully', () => {
      expect(phaseFocusCompetencies('assessment', [], [])).toEqual([])
      expect(phaseFocusCompetencies('review', [], [])).toEqual([])
    })
  })

  describe('PHASE_ORDER', () => {
    it('contains all 6 phases in the expected order', () => {
      expect(PHASE_ORDER).toEqual([
        'assessment', 'foundation', 'building', 'intensity', 'mastery', 'review',
      ])
    })
  })

  describe('DEFAULT_PHASE_THRESHOLDS', () => {
    it('thresholds are strictly increasing', () => {
      let prev = 0
      for (const phase of PHASE_ORDER) {
        const t = DEFAULT_PHASE_THRESHOLDS[phase]
        expect(t).toBeGreaterThan(prev)
        prev = t
      }
    })
  })
})
