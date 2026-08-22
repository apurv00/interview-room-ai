import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import { SAMPLE_RESUME_DATA } from '../../config/templates'
import type { ResumeData } from '../../validators/resume'

/**
 * Headless-browser PDF render harness.
 *
 * The jsdom parity gate proves the PREVIEW markup but cannot prove the exported
 * PDF, because the PDF uses the precompiled Tailwind bundle + a real layout
 * engine. That blind spot shipped an unstyled-PDF P1 on #411 (the extracted
 * layout/theme classes were missing from the PDF CSS scan). This test renders
 * the real PDF HTML in Chromium and asserts (a) template styling is actually
 * applied (would catch the missing-class regression), and (b) pagination
 * produces the expected page count without dropping content.
 *
 * Opt-in (RESUME_PDF_E2E=1) so the default unit suite / `ci` job stays
 * browser-free and fast. Run with: `npm run test:pdf`. Once explicitly
 * enabled, browser launch is part of the gate and must fail closed.
 */

const ENABLED = process.env.RESUME_PDF_E2E === '1'

let browser: any = null

async function launchBrowser() {
  const puppeteer = require('puppeteer-core')
  const chromiumMod = require('@sparticuz/chromium')
  const chromium = chromiumMod.default ?? chromiumMod
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath())
  return puppeteer.launch({
    args: [...(Array.isArray(chromium.args) ? chromium.args : []), '--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
    headless: true,
  })
}

interface PageMetrics {
  pageCount: number
  sectionHeaderFontWeight: string
  sectionHeaderTextTransform: string
  bandBackgroundColor: string | null
  /** Whether `visibleText` (if supplied) actually lands inside a page viewport's
   * visible band — not merely present in the (clipped) DOM. */
  needleVisible: boolean
}

async function renderAndMeasure(
  data: ResumeData,
  templateId: string,
  visibleText?: string,
): Promise<PageMetrics> {
  const html = renderResumeHTML(data, templateId)
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as { __resumePagesReady?: boolean }).__resumePagesReady === true,
      { timeout: 15000 },
    )
    return page.evaluate((needle: string | null) => {
      const root = document.getElementById('resume-pages-root')!
      const pages = root.querySelectorAll('.resume-page')
      const header = root.querySelector('[data-resume-section-header]') as HTMLElement | null
      const band = root.querySelector('[data-resume-section="contact"], [data-resume-section="body"]') as HTMLElement | null
      const colored = band || (root.querySelector('h1')?.parentElement as HTMLElement | null)
      const hs = header ? getComputedStyle(header) : null
      const cs = colored ? getComputedStyle(colored) : null

      // Each .resume-page duplicates the full template and clips it with the
      // viewport's overflow:hidden, so DOM-text presence proves nothing. A text
      // is genuinely visible only if a leaf element containing it has a bounding
      // rect that falls WITHIN some page viewport's visible band (no clip).
      let needleVisible = needle === null
      if (needle !== null) {
        for (const page of Array.from(pages)) {
          const vp = page.querySelector('.resume-page-viewport') as HTMLElement | null
          if (!vp) continue
          const vpRect = vp.getBoundingClientRect()
          const leaves = Array.from(vp.querySelectorAll('*')).filter(
            el => el.children.length === 0 && (el.textContent || '').includes(needle),
          )
          for (const el of leaves) {
            const r = el.getBoundingClientRect()
            if (r.height > 0 && r.top >= vpRect.top - 1 && r.bottom <= vpRect.bottom + 1) {
              needleVisible = true
              break
            }
          }
          if (needleVisible) break
        }
      }

      return {
        pageCount: pages.length,
        sectionHeaderFontWeight: hs?.fontWeight ?? '',
        sectionHeaderTextTransform: hs?.textTransform ?? '',
        bandBackgroundColor: cs?.backgroundColor ?? null,
        needleVisible,
      }
    }, visibleText ?? null)
  } finally {
    await page.close()
  }
}

function longResume(): ResumeData {
  const base = SAMPLE_RESUME_DATA as unknown as ResumeData
  const experience = Array.from({ length: 10 }, (_, i) => ({
    id: `exp-${i}`,
    company: `Company ${i}`,
    title: `Senior Engineer ${i}`,
    location: 'Remote',
    startDate: '2018',
    endDate: '2024',
    bullets: Array.from({ length: 5 }, (_, b) => `Accomplishment ${i}.${b} — delivered measurable impact across teams and systems at scale`),
  }))
  return { ...base, experience } as unknown as ResumeData
}

describe.skipIf(!ENABLED)('PDF render (headless Chromium)', () => {
  beforeAll(async () => {
    browser = await launchBrowser()
  }, 60000)

  afterAll(async () => {
    if (browser) await browser.close()
  })

  it('applies template styling in the exported PDF (guards the missing-CSS regression)', async () => {
    const m = await renderAndMeasure(SAMPLE_RESUME_DATA as unknown as ResumeData, 'professional')
    // Professional section titles are font-bold + uppercase. If the PDF CSS were
    // missing these classes (the #411 P1), computed styles would be the defaults.
    expect(m.pageCount).toBeGreaterThanOrEqual(1)
    expect(Number(m.sectionHeaderFontWeight)).toBeGreaterThanOrEqual(600)
    expect(m.sectionHeaderTextTransform).toBe('uppercase')
  }, 30000)

  it('renders the Modern accent band with its themed background color', async () => {
    const m = await renderAndMeasure(SAMPLE_RESUME_DATA as unknown as ResumeData, 'modern-indigo')
    // bg-indigo-600 = #4f46e5 = rgb(79, 70, 229). A transparent band would mean
    // the family/theme classes never reached the precompiled PDF CSS.
    expect(m.bandBackgroundColor).toBe('rgb(79, 70, 229)')
  }, 30000)

  it('paginates a long resume across multiple pages without dropping content', async () => {
    // The last experience entry must be VISIBLE on a page (within a viewport's
    // clip band), not merely present in the duplicated/clipped DOM.
    const m = await renderAndMeasure(longResume(), 'professional', 'Senior Engineer 9')
    expect(m.pageCount).toBeGreaterThan(1)
    expect(m.needleVisible).toBe(true)
  }, 30000)
})
