import { describe, it, expect } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import type { ResumeData } from '../../validators/resume'
import { applySkillsTruncationToData } from '../../lib/skillCategoryTruncation'

const data = {
  contactInfo: { fullName: 'Jane Doe', email: 'jane@example.com' },
  skills: [{ category: 'Languages', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }],
} as unknown as ResumeData

describe('renderResumeHTML — skills truncation parity with the preview', () => {
  it('renders every skill item and no "+N more" cue for un-truncated data', () => {
    const html = renderResumeHTML(data, 'technical')
    expect(html).toContain('a, b, c, d, e, f, g, h')
    expect(html).not.toMatch(/\+\d+ more/)
  })

  // Restored (was skipped): the "+N more" cue now rides the DATA, not the client
  // pageContext — applySkillsTruncationToData bakes an `omittedCount` onto the
  // truncated category, so ResumeSkillsSection renders the cue in server output
  // (PDF/print) exactly as in the preview. This is the follow-up the old skip
  // note tracked; the server render no longer depends on a client React context.
  it('slices items and adds the "+N more" cue for truncated data (PDF/export path)', () => {
    // keptSkillItemCount(8, 0.5) = floor(8 * 0.5) = 4 → keep a..d, omit 4.
    const truncated = applySkillsTruncationToData(data, { 0: 0.5 })
    const html = renderResumeHTML(truncated, 'technical')
    expect(html).toContain('a, b, c, d')
    expect(html).not.toContain('e, f, g, h')
    expect(html).toContain('+4 more')
  })

  it('leaves un-truncated categories with every item and no cue', () => {
    // ratio 1 → no slice, no omittedCount, no cue.
    const untouched = applySkillsTruncationToData(data, { 0: 1 })
    const html = renderResumeHTML(untouched, 'technical')
    expect(html).toContain('a, b, c, d, e, f, g, h')
    expect(html).not.toMatch(/\+\d+ more/)
  })
})
