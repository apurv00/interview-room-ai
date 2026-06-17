import { describe, it, expect } from 'vitest'
import { BUILT_IN_RUBRICS } from '../seedPersonalization'

/**
 * RUBRIC COVERAGE GUARD.
 *
 * Every interview type must have at least a generic `{ domain: '*', type, band: '*' }`
 * rubric so that getRubric() never falls through to a wrong-type rubric (or none) for
 * domains without a specific rubric. Domain flavor is layered on at eval time from each
 * domain's skill-file scoring-emphasis; the rubric supplies the calibrated scoring bands.
 *
 * Before this guard, only `behavioral` had a '*' rubric — technical/case-study/
 * system-design/coding rounds in ~22 domains scored with no rubric bands at all.
 */
const INTERVIEW_TYPES = ['behavioral', 'technical', 'case-study', 'system-design', 'coding'] as const

describe('rubric coverage', () => {
  it('has a generic { domain: "*", seniorityBand: "*" } rubric for every interview type', () => {
    const missing = INTERVIEW_TYPES.filter(
      type =>
        !BUILT_IN_RUBRICS.some(
          r => r.domain === '*' && r.interviewType === type && r.seniorityBand === '*',
        ),
    )
    expect(missing, `Interview types with no generic '*' rubric: ${missing.join(', ')}`).toEqual([])
  })

  it('every rubric dimension set has weights summing to ~1.0', () => {
    const bad: string[] = []
    for (const r of BUILT_IN_RUBRICS) {
      const sum = r.dimensions.reduce((acc, d) => acc + d.weight, 0)
      if (Math.abs(sum - 1) > 0.001) bad.push(`${r.rubricId}=${sum.toFixed(2)}`)
    }
    expect(bad, `Rubrics whose weights don't sum to 1.0: ${bad.join(', ')}`).toEqual([])
  })
})
