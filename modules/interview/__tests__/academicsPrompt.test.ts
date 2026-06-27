import { describe, it, expect } from 'vitest'
import { academicGroundingDirective } from '@interview/services/core/academicsPrompt'

describe('academicGroundingDirective', () => {
  it('returns an empty string for non-academics interview types', () => {
    expect(academicGroundingDirective('behavioral')).toBe('')
    expect(academicGroundingDirective('technical')).toBe('')
    expect(academicGroundingDirective('case-study')).toBe('')
    expect(academicGroundingDirective(undefined)).toBe('')
    expect(academicGroundingDirective('')).toBe('')
  })

  describe('for academics', () => {
    const directive = academicGroundingDirective('academics')

    it('is non-empty', () => {
      expect(directive.length).toBeGreaterThan(0)
    })

    // The bug: Q1 (prefetched before the intro answer is captured) re-asked the
    // favourite-subject question that the SPOKEN intro already asked. This guard is
    // the contract that prevents the duplication — these assertions pin it so a future
    // edit to the directive cannot silently drop the protection.
    it('explicitly forbids re-asking the favourite-subject opener', () => {
      expect(directive).toMatch(/NEVER RE-ASK THE OPENER/i)
      expect(directive).toMatch(/already asked/i)
      expect(directive).toMatch(/do not ask it again/i)
    })

    it('tells the model the favourite-subject question is the spoken opening', () => {
      expect(directive).toMatch(/spoken opening/i)
      expect(directive).toMatch(/which academic subject are you strongest in/i)
    })

    it('directs Q1 to a roadmap warm-up when the named subject is not yet in context', () => {
      expect(directive).toMatch(/roadmap/i)
      expect(directive).toMatch(/first question you generate/i)
      expect(directive).toMatch(/never ask them which subject/i)
    })

    it('keeps the existing subject-anchoring rule (drill the named subject, no off-subject drift)', () => {
      expect(directive).toMatch(/anchor the entire round to it/i)
      expect(directive).toMatch(/NEVER switch to a different syllabus subject/i)
    })
  })
})
