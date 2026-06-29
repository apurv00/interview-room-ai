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

    // Résumé-drift fix (2026-06-29): the directive previously hard-coded "digital marketing"
    // as its worked example, which a 300-token model COPIED as the subject on the prefetched
    // Q1 (when the real subject isn't in context yet) — producing "You mentioned digital
    // marketing" for a candidate who named consumer behaviour. The directive must seed NO
    // concrete example subject, and must forbid inferring the subject from the résumé.
    it('does NOT seed any concrete example subject (de-seeded)', () => {
      expect(directive.toLowerCase()).not.toContain('digital marketing')
      expect(directive.toLowerCase()).not.toContain('operating systems')
    })

    it('forbids inferring/substituting the subject from the résumé, background, or an example', () => {
      expect(directive).toMatch(/never infer, substitute, or guess a subject/i)
      expect(directive).toMatch(/r[ée]sum[ée]/i)
      expect(directive).toMatch(/only the subject they explicitly stated/i)
      expect(directive).toMatch(/never attribute a subject to the candidate that they did not say/i)
    })
  })
})
