import { describe, it, expect } from 'vitest'
import {
  applySkillsTruncationToData,
  isFullSkillsMeasure,
  keptSkillItemCount,
  omittedSkillItemCount,
  refineSkillRatiosIfStillOversized,
  skillsMatchTruncationRatios,
} from '../skillCategoryTruncation'
import type { SkillsSectionMeasurement } from '../resumePageBreaks'
import type { ResumeData } from '../../validators/resume'

const baseData: ResumeData = {
  contactInfo: { fullName: 'Test', email: 't@example.com' },
  skills: [
    { category: 'Languages', items: ['a', 'b', 'c', 'd', 'e'] },
    { category: 'Tools', items: ['x', 'y'] },
  ],
}

describe('skillCategoryTruncation', () => {
  it('slices skills data to match layout ratios', () => {
    const truncated = applySkillsTruncationToData(baseData, { 0: 0.4 })
    expect(truncated.skills?.[0].items).toHaveLength(2)
    expect(truncated.skills?.[1].items).toHaveLength(2)
  })

  it('detects when skills already match truncation ratios', () => {
    const truncated = applySkillsTruncationToData(baseData, { 0: 0.4 })
    expect(skillsMatchTruncationRatios(truncated.skills, { 0: 0.4 }, baseData.skills)).toBe(true)
    expect(skillsMatchTruncationRatios(baseData.skills, { 0: 0.4 }, baseData.skills)).toBe(false)
  })

  it('computes kept and omitted item counts', () => {
    expect(keptSkillItemCount(5, 0.4)).toBe(2)
    expect(omittedSkillItemCount(5, 0.4)).toBe(3)
    expect(omittedSkillItemCount(1, 0.2)).toBe(0)
  })

  it('detects full vs truncated measure passes', () => {
    const truncated = applySkillsTruncationToData(baseData, { 0: 0.4 })
    expect(isFullSkillsMeasure(baseData.skills, baseData.skills)).toBe(true)
    expect(isFullSkillsMeasure(truncated.skills, baseData.skills)).toBe(false)
  })

  it('refines ratios by item count when truncated DOM is still oversized', () => {
    const skillsSection: SkillsSectionMeasurement = {
      kind: 'skills',
      offsetTop: 0,
      offsetHeight: 900,
      header: { offsetTop: 0, offsetHeight: 20 },
      categories: [{ categoryIndex: 0, offsetTop: 24, offsetHeight: 850 }],
    }
    const truncated = applySkillsTruncationToData(baseData, { 0: 0.4 })
    const refined = refineSkillRatiosIfStillOversized(
      skillsSection,
      800,
      { 0: 0.4 },
      baseData.skills!,
      truncated.skills!,
    )
    expect(refined).toEqual({ 0: 0.2 })
  })
})
