import { describe, it, expect } from 'vitest'
import {
  stdDev,
  tagStability,
  formatConsistencyReportMarkdown,
  type ConsistencyReport,
} from '@cms/services/benchmarkService'

describe('consistency harness helpers', () => {
  describe('stdDev', () => {
    it('returns 0 for an empty array', () => {
      expect(stdDev([])).toBe(0)
    })

    it('returns 0 when all values are identical (perfect determinism)', () => {
      expect(stdDev([80, 80, 80, 80, 80])).toBe(0)
    })

    it('computes population std dev for a small sample', () => {
      // values: [70, 75, 80, 85, 90], mean=80, variance=50, stdDev≈7.07
      const result = stdDev([70, 75, 80, 85, 90])
      expect(result).toBeGreaterThan(7)
      expect(result).toBeLessThan(7.5)
    })

    it('grows with spread', () => {
      const tight = stdDev([78, 80, 82])
      const wide = stdDev([60, 80, 100])
      expect(wide).toBeGreaterThan(tight)
    })
  })

  describe('tagStability', () => {
    it('returns 1.0 when every run produces the same tag set', () => {
      const sets = [
        ['quantified impact', 'ownership'],
        ['quantified impact', 'ownership'],
        ['quantified impact', 'ownership'],
      ]
      expect(tagStability(sets)).toBe(1)
    })

    it('returns less than 1.0 when tag sets diverge', () => {
      const sets = [
        ['quantified impact', 'ownership'],
        ['quantified impact', 'structure'],
        ['vague', 'no metrics'],
      ]
      const stability = tagStability(sets)
      expect(stability).toBeGreaterThan(0)
      expect(stability).toBeLessThan(1)
    })

    it('returns 0 for empty input', () => {
      expect(tagStability([])).toBe(0)
    })

    it('normalizes tag casing and separators', () => {
      const sets = [
        ['Quantified Impact', 'OWNERSHIP'],
        ['quantified-impact', 'ownership'],
        ['quantified_impact', 'Ownership'],
      ]
      expect(tagStability(sets)).toBe(1)
    })
  })

  describe('formatConsistencyReportMarkdown', () => {
    it('produces a markdown report with per-case sections', () => {
      const report: ConsistencyReport = {
        totalCases: 1,
        runsPerCase: 3,
        temperature: 0,
        results: [
          {
            caseId: 'fixture_strong_star_001',
            domain: 'product',
            interviewType: 'behavioral',
            runs: 3,
            dimensionStats: [
              { dimension: 'relevance', mean: 90, stdDev: 1.5, min: 88, max: 92, values: [88, 90, 92] },
              { dimension: 'structure', mean: 85, stdDev: 2.0, min: 82, max: 88, values: [82, 85, 88] },
            ],
            overallScore: { mean: 87.5, stdDev: 1.8, min: 85, max: 90, values: [85, 88, 90] },
            strengthTagStability: 1,
            weaknessTagStability: 0.6,
            errors: 0,
          },
        ],
        meanStdDev: 1.75,
        worstStdDev: 2.0,
        runAt: new Date('2026-04-07T00:00:00Z'),
        durationMs: 12_345,
      }

      const md = formatConsistencyReportMarkdown(report)
      expect(md).toContain('# Scoring Consistency Report')
      expect(md).toContain('fixture_strong_star_001')
      expect(md).toContain('| relevance |')
      expect(md).toContain('Strength tag stability: 100%')
      expect(md).toContain('Weakness tag stability: 60%')
      expect(md).toContain('Mean dimension std dev:')
    })
  })
})
