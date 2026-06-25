/**
 * buildScoringGuide — picks the evaluate-answer scoring-guide block by depth.
 * Load-bearing property: the academics depth (a subject viva) must NOT be scored
 * against STAR/behavioral structure, while every other depth keeps the unchanged
 * legacy STAR-anchored guide byte-for-byte.
 */
import { describe, it, expect } from 'vitest'
import {
  buildScoringGuide,
  DEFAULT_SCORING_GUIDE,
  ACADEMIC_SCORING_GUIDE,
} from '@interview/services/eval/scoringGuide'

describe('buildScoringGuide', () => {
  it('returns the academic subject-viva guide for the academics depth', () => {
    expect(buildScoringGuide('academics')).toBe(ACADEMIC_SCORING_GUIDE)
  })

  it('returns the default STAR-anchored guide for every other depth (and unknowns)', () => {
    for (const depth of ['behavioral', 'technical', 'case-study', 'system-design', 'coding', 'some-cms-depth', '']) {
      expect(buildScoringGuide(depth)).toBe(DEFAULT_SCORING_GUIDE)
    }
  })

  it('academic guide scores conceptual understanding, NOT STAR/behavioral structure', () => {
    expect(ACADEMIC_SCORING_GUIDE).toMatch(/SUBJECT VIVA/i)
    expect(ACADEMIC_SCORING_GUIDE).toMatch(/first-principles/i)
    // must NOT carry the STAR anchor that would mis-score a subject answer
    expect(ACADEMIC_SCORING_GUIDE).not.toMatch(/STAR-structured/i)
  })

  it('default guide keeps the STAR anchor (unchanged legacy calibration)', () => {
    expect(DEFAULT_SCORING_GUIDE).toMatch(/STAR-structured/i)
  })

  it('both guides keep all five calibration bands', () => {
    for (const guide of [DEFAULT_SCORING_GUIDE, ACADEMIC_SCORING_GUIDE]) {
      expect(guide).toMatch(/0–20/)
      expect(guide).toMatch(/21–40/)
      expect(guide).toMatch(/41–60/)
      expect(guide).toMatch(/61–80/)
      expect(guide).toMatch(/81–100/)
    }
  })

  it('academic guide carries the accuracy guardrails (accept "look up", reward honesty)', () => {
    expect(ACADEMIC_SCORING_GUIDE).toMatch(/look up/i)
    expect(ACADEMIC_SCORING_GUIDE).toMatch(/honest/i)
  })
})
