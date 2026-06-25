/**
 * buildScoringGuide — picks the evaluate-answer scoring-guide block by depth.
 * Load-bearing property: the academics depth (a subject viva) must NOT be scored
 * against STAR/behavioral structure, while every other depth keeps the unchanged
 * legacy STAR-anchored guide byte-for-byte.
 */
import { describe, it, expect } from 'vitest'
import {
  buildScoringGuide,
  resolveEvalDepthSlug,
  DEFAULT_SCORING_GUIDE,
  ACADEMIC_SCORING_GUIDE,
} from '@interview/services/eval/scoringGuide'

describe('buildScoringGuide', () => {
  it('returns the academic subject-viva guide for the academics depth', () => {
    expect(buildScoringGuide('academics')).toBe(ACADEMIC_SCORING_GUIDE)
  })

  it('via resolveEvalDepthSlug: academics warm-ups (index 0 + 1) get the default guide, real viva probes the academic guide', () => {
    // The intro and the favourite-subject naming must not be graded on derivation/conceptual
    // correctness (they would be marked off-topic and drag down the aggregate).
    expect(buildScoringGuide(resolveEvalDepthSlug('academics', 0))).toBe(DEFAULT_SCORING_GUIDE)  // intro
    expect(buildScoringGuide(resolveEvalDepthSlug('academics', 1))).toBe(DEFAULT_SCORING_GUIDE)  // favourite-subject warm-up
    expect(buildScoringGuide(resolveEvalDepthSlug('academics', 2))).toBe(ACADEMIC_SCORING_GUIDE) // first real viva probe
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

describe('resolveEvalDepthSlug', () => {
  it('evaluates the academics warm-ups (index 0 intro + index 1 favourite-subject) as behavioral', () => {
    expect(resolveEvalDepthSlug('academics', 0)).toBe('behavioral')
    expect(resolveEvalDepthSlug('academics', 1)).toBe('behavioral')
  })

  it('keeps the academics depth for real viva probes (index >= 2)', () => {
    expect(resolveEvalDepthSlug('academics', 2)).toBe('academics')
    expect(resolveEvalDepthSlug('academics', 5)).toBe('academics')
  })

  it('never rewrites a non-academics depth, even at index 0', () => {
    expect(resolveEvalDepthSlug('behavioral', 0)).toBe('behavioral')
    expect(resolveEvalDepthSlug('technical', 0)).toBe('technical')
    expect(resolveEvalDepthSlug('coding', 1)).toBe('coding')
  })

  it('treats a missing questionIndex as a viva answer (academics stays academics)', () => {
    expect(resolveEvalDepthSlug('academics')).toBe('academics')
  })
})
