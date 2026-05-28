import { describe, it, expect } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import type { ResumeData } from '../../validators/resume'
import type { ResumePreviewPageContextValue } from '../../components/ResumePreviewPageContext'

const data = {
  contactInfo: { fullName: 'Jane Doe', email: 'jane@example.com' },
  skills: [{ category: 'Languages', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }],
} as unknown as ResumeData

describe('renderResumeHTML — skills truncation parity with the preview', () => {
  it('renders every skill item and no "+N more" cue without a page context', () => {
    const html = renderResumeHTML(data, 'technical')
    expect(html).toContain('a, b, c, d, e, f, g, h')
    expect(html).not.toMatch(/\+\d+ more/)
  })

  it('slices items and adds the "+N more" cue when a ratio < 1 is supplied (PDF/export path)', () => {
    // keptSkillItemCount(8, 0.5) = floor(8 * 0.5) = 4 → keep a..d.
    const ctx: ResumePreviewPageContextValue = {
      skillsContinuationHeader: false,
      truncatedSkillCategoryIndices: [0],
      truncatedSkillCategoryRatios: { 0: 0.5 },
      truncatedSkillCategoryOmittedCounts: { 0: 4 },
    }
    const html = renderResumeHTML(data, 'technical', ctx)
    expect(html).toContain('a, b, c, d')
    expect(html).not.toContain('e, f, g, h')
    expect(html).toContain('+4 more')
  })

  it('renders the "+N more" cue WITHOUT re-slicing when ratio is 1 (hidden measurer parity)', () => {
    // Mirrors the measurer: items are already truncated upstream (here passed
    // full for clarity), ratios empty so no second slice, but the omitted count
    // must still produce the "+N more" row so measured height matches render.
    const ctx: ResumePreviewPageContextValue = {
      skillsContinuationHeader: false,
      truncatedSkillCategoryIndices: [0],
      truncatedSkillCategoryRatios: {},
      truncatedSkillCategoryOmittedCounts: { 0: 3 },
    }
    const html = renderResumeHTML(data, 'technical', ctx)
    expect(html).toContain('a, b, c, d, e, f, g, h') // not re-sliced
    expect(html).toContain('+3 more') // annotation still rendered
  })
})
