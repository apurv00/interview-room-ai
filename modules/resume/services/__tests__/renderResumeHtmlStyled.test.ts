import { describe, it, expect } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import { SAMPLE_RESUME_DATA } from '../../config/templates'
import type { ResumeData } from '../../validators/resume'

/**
 * Guards the styled print/download fallback (the `/api/resume/pdf-html` route).
 *
 * The old browser-print fallback cloned the live preview DOM into a bare window
 * with no stylesheet, so every Tailwind class resolved to nothing and the PDF
 * came out as raw text in lines — for ALL templates. The fallback now serves
 * `renderResumeHTML`, which inlines the precompiled Tailwind bundle and the A4
 * page CSS. This test asserts that output is genuinely styled + paginatable for
 * a spread of families, so the raw-text regression can't come back unnoticed.
 */
const TEMPLATES = ['professional', 'technical', 'creative', 'executive', 'startup', 'minimalist']

describe('renderResumeHTML produces a self-contained, styled document', () => {
  for (const templateId of TEMPLATES) {
    const html = renderResumeHTML(
      { ...(SAMPLE_RESUME_DATA as unknown as ResumeData), template: templateId },
      templateId,
    )

    it(`${templateId}: inlines a substantial Tailwind stylesheet (not raw text)`, () => {
      const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) ?? []
      const totalCss = styleBlocks.join('').length
      // The precompiled Tailwind bundle is ~25 KB; a bare/raw document would be
      // a few hundred bytes. Require real CSS so an unstyled regression fails.
      expect(totalCss).toBeGreaterThan(5000)
    })

    it(`${templateId}: carries the pagination structure + ready signal`, () => {
      expect(html).toContain('id="resume-pages-root"')
      expect(html).toContain('id="resume-template-root"')
      expect(html).toContain('__resumePagesReady')
      // Section markers the paginator/print relies on must be present.
      expect(html).toContain('data-resume-section')
    })

    it(`${templateId}: sets an A4 page so it prints to the right paper size`, () => {
      expect(html).toContain('@page')
      expect(html).toContain('A4')
    })
  }
})
