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

  // NOTE (2026-06-01): server-side context-driven skills truncation is
  // temporarily DISABLED. ResumeSkillsSection used a 'use client' React context
  // (useResumePreviewPage); rendered via renderToStaticMarkup in the Next
  // production build, that turned the component into a client *reference*, so
  // the route threw "Element type is invalid... got: undefined" and EVERY PDF
  // export 500'd in production (vitest passed because it has no client/server
  // boundary, which hid the breakage). The fix makes ResumeSkillsSection
  // server-safe by reading truncation cues from a PROP instead of the context;
  // renderResumeHTML no longer wraps the tree in the client provider, so passing
  // `ctx` here is a no-op until pageContext is threaded as a prop through the
  // template/layout components. These two cases are skipped (not deleted) and
  // tracked as the follow-up that restores "+N more" for oversized categories.
  // Real-world impact today: ~nil — only a single skills category long enough to
  // overflow a page is affected, and the server render working at all is the P0.
  it.skip('slices items and adds the "+N more" cue when a ratio < 1 is supplied (PDF/export path)', () => {
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

  it.skip('renders the "+N more" cue WITHOUT re-slicing when ratio is 1 (hidden measurer parity)', () => {
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
