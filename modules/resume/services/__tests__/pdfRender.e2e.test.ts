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
 * browser-free and fast. Run with: `npm run test:pdf`. If the browser cannot
 * launch in this environment, the suite skips rather than false-failing.
 */

const ENABLED = process.env.RESUME_PDF_E2E === '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any = null

async function launchBrowser() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  containsText: (needle: string) => boolean
  text: string
}

async function renderAndMeasure(data: ResumeData, templateId: string): Promise<PageMetrics> {
  const html = renderResumeHTML(data, templateId)
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(html, { waitUntil: 'networkidle0' })
    await page.waitForFunction(
      () => (window as { __resumePagesReady?: boolean }).__resumePagesReady === true,
      { timeout: 15000 },
    )
    return page.evaluate(() => {
      const root = document.getElementById('resume-pages-root')!
      const pages = root.querySelectorAll('.resume-page')
      const header = root.querySelector('[data-resume-section-header]') as HTMLElement | null
      const band = root.querySelector('[data-resume-section="contact"], [data-resume-section="body"]') as HTMLElement | null
      // Heuristic for accent-band families (Modern/Sidebar): first colored block.
      const colored = band || (root.querySelector('h1')?.parentElement as HTMLElement | null)
      const hs = header ? getComputedStyle(header) : null
      const cs = colored ? getComputedStyle(colored) : null
      const text = (root as HTMLElement).innerText
      return {
        pageCount: pages.length,
        sectionHeaderFontWeight: hs?.fontWeight ?? '',
        sectionHeaderTextTransform: hs?.textTransform ?? '',
        bandBackgroundColor: cs?.backgroundColor ?? null,
        text,
        // serialized below; reattach helper on the node side
      } as unknown as PageMetrics
    }).then((m: PageMetrics) => ({
      ...m,
      containsText: (needle: string) => m.text.includes(needle),
    }))
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
    try {
      browser = await launchBrowser()
    } catch (err) {
      console.warn('[pdfRender.e2e] browser launch failed — skipping:', (err as Error).message)
      browser = null
    }
  }, 60000)

  afterAll(async () => {
    if (browser) await browser.close()
  })

  it('applies template styling in the exported PDF (guards the missing-CSS regression)', async (ctx) => {
    if (!browser) return ctx.skip()
    const m = await renderAndMeasure(SAMPLE_RESUME_DATA as unknown as ResumeData, 'professional')
    // Professional section titles are font-bold + uppercase. If the PDF CSS were
    // missing these classes (the #411 P1), computed styles would be the defaults.
    expect(m.pageCount).toBeGreaterThanOrEqual(1)
    expect(Number(m.sectionHeaderFontWeight)).toBeGreaterThanOrEqual(600)
    expect(m.sectionHeaderTextTransform).toBe('uppercase')
  }, 30000)

  it('renders the Modern accent band with its themed background color', async (ctx) => {
    if (!browser) return ctx.skip()
    const m = await renderAndMeasure(SAMPLE_RESUME_DATA as unknown as ResumeData, 'modern-indigo')
    // bg-indigo-600 = #4f46e5 = rgb(79, 70, 229). A transparent band would mean
    // the family/theme classes never reached the precompiled PDF CSS.
    expect(m.bandBackgroundColor).toBe('rgb(79, 70, 229)')
  }, 30000)

  it('paginates a long resume across multiple pages without dropping content', async (ctx) => {
    if (!browser) return ctx.skip()
    const m = await renderAndMeasure(longResume(), 'professional')
    expect(m.pageCount).toBeGreaterThan(1)
    // The last experience entry must survive pagination.
    expect(m.containsText('Senior Engineer 9')).toBe(true)
  }, 30000)
})
