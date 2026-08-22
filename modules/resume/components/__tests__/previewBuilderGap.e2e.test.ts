import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const ENABLED = process.env.RESUME_PDF_E2E === '1'
const BASE = (process.env.PREVIEW_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')

let browser: any = null

async function launchBrowser() {
  const puppeteer = require('puppeteer-core')
  const chromiumMod = require('@sparticuz/chromium')
  const chromium = chromiumMod.default ?? chromiumMod
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath())
  return puppeteer.launch({
    args: [...(Array.isArray(chromium.args) ? chromium.args : []), '--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
    headless: true,
  })
}

const draft = {
  template: 'academic',
  contactInfo: { fullName: 'Test User', email: 't@e.com' },
  summary: 'Research interests in machine learning and NLP systems.',
  education: [{ id: '1', institution: 'MIT', degree: 'PhD', field: 'CS', graduationDate: '2024' }],
  experience: Array.from({ length: 8 }, (_, i) => ({
    id: 'e' + i,
    company: 'Research Lab ' + i,
    title: 'Research Assistant',
    startDate: '2020',
    endDate: '2024',
    bullets: Array.from({ length: 6 }, (_, b) =>
      `Bullet ${b + 1}: Conducted extensive research with long bullet text that wraps multiple lines on the page to force pagination across pages and continuation headers.`,
    ),
  })),
  skills: [
    { category: 'AI & Automation Tools', items: ['Python', 'TensorFlow', 'PyTorch', 'LangChain', 'OpenAI API'] },
    { category: 'Languages', items: ['English', 'Hindi', 'French'] },
    { category: 'Frameworks', items: ['React', 'Next.js', 'Node', 'FastAPI'] },
    { category: 'Databases', items: ['PostgreSQL', 'MongoDB', 'Redis'] },
  ],
  projects: [],
  certifications: [],
  customSections: [],
  styling: { fontFamily: 'georgia', fontSize: 'medium' },
}

interface GapRow {
  pageIdx: number
  sectionId: string | null
  useCont: boolean
  gapToMarginPx: number | null
  straddlers: Array<{ text: string; topPx: number; bottomPx: number }>
  flowHeaderDisplay: string | null
  flowHeaderVisibility: string | null
  contMinHeight: string | null
}

const SUBPIXEL_TOLERANCE_PX = 0.5

describe.runIf(ENABLED)('builder ResumePreview — section header gaps', () => {
  beforeAll(async () => {
    browser = await launchBrowser()
  }, 60000)
  afterAll(async () => {
    if (browser) await browser.close()
  })

  it('measures live preview gaps (runtime evidence)', async () => {
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 1440, height: 1200 })
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.evaluate((d) => {
        localStorage.setItem('resume:draft:anon', JSON.stringify(d))
      }, draft)
      await page.goto(`${BASE}/resume/builder?template=academic`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })
      await page.waitForSelector('#resume-preview-container [data-resume-page-viewport]', {
        timeout: 30000,
      })
      await page.waitForFunction(() => document.fonts?.status === 'loaded', { timeout: 15000 }).catch(
        () => undefined,
      )
      await page.waitForFunction(
        () => Array.from(
          document.querySelectorAll('#resume-preview-container [data-resume-page-viewport]'),
        ).some(viewport => (
          viewport.querySelector('[data-resume-continuation-header]')
          && viewport.querySelector('[data-resume-page-content][data-suppress-section]')
        )),
        { timeout: 30000 },
      )

      const rows = (await page.evaluate((tolerance: number) => {
        const out: GapRow[] = []
        document
          .querySelectorAll('#resume-preview-container [data-resume-page-viewport]')
          .forEach((viewport, pageIdx) => {
            const viewportRect = viewport.getBoundingClientRect()
            const contHdr = viewport.querySelector(
              '[data-resume-continuation-header]',
            ) as HTMLElement | null
            const contBottom = contHdr?.getBoundingClientRect().bottom ?? null
            const content = viewport.querySelector(
              '[data-resume-page-content]',
            ) as HTMLElement | null
            const suppressSectionId = content?.getAttribute('data-suppress-section') ?? null

            viewport.querySelectorAll('[data-resume-section]').forEach(section => {
              const sectionId = section.getAttribute('data-resume-section')
              const flowHeader = section.querySelector(
                '[data-resume-section-header], [data-resume-skills-header]',
              ) as HTMLElement | null
              const h2 = (flowHeader?.matches('h2')
                ? flowHeader
                : flowHeader?.querySelector('h2')) as HTMLElement | null
              if (!flowHeader || !h2) return

              const h2Rect = h2.getBoundingClientRect()
              const mb = parseFloat(getComputedStyle(h2).marginBottom) || 0
              const useCont = Boolean(
                contHdr && contBottom != null && sectionId === suppressSectionId,
              )

              if (useCont) {
                const lineRects: Array<{ text: string; top: number; bottom: number }> = []
                const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
                let textNode = walker.nextNode()
                while (textNode) {
                  const parent = textNode.parentElement
                  const text = textNode.textContent?.trim() ?? ''
                  if (
                    parent
                    && text
                    && !parent.closest(
                      '[data-resume-section-header], [data-resume-skills-header]',
                    )
                    && getComputedStyle(parent).visibility !== 'hidden'
                    && getComputedStyle(parent).display !== 'none'
                  ) {
                    const range = document.createRange()
                    range.selectNodeContents(textNode)
                    for (const rect of Array.from(range.getClientRects())) {
                      if (rect.width > 0 && rect.height > 0) {
                        lineRects.push({ text, top: rect.top, bottom: rect.bottom })
                      }
                    }
                  }
                  textNode = walker.nextNode()
                }

                const relevantLines = lineRects.filter(
                  rect => (
                    rect.bottom > contBottom! + tolerance
                    && rect.top < viewportRect.bottom - tolerance
                  ),
                )
                const firstLineTop = relevantLines.length > 0
                  ? Math.min(...relevantLines.map(rect => rect.top))
                  : null
                const straddlers = relevantLines
                  .filter(rect => (
                    rect.top < contBottom! - tolerance
                    && rect.bottom > contBottom! + tolerance
                  ))
                  .map(rect => ({
                    text: rect.text.slice(0, 80),
                    topPx: Math.round((rect.top - contBottom!) * 1000) / 1000,
                    bottomPx: Math.round((rect.bottom - contBottom!) * 1000) / 1000,
                  }))

                out.push({
                  pageIdx,
                  sectionId,
                  useCont: true,
                  gapToMarginPx: firstLineTop == null
                    ? null
                    : Math.round((firstLineTop - contBottom!) * 1000) / 1000,
                  straddlers,
                  flowHeaderDisplay: getComputedStyle(flowHeader).display,
                  flowHeaderVisibility: getComputedStyle(flowHeader).visibility,
                  contMinHeight: contHdr?.style.minHeight ?? null,
                })
                return
              }

              const units = Array.from(
                section.querySelectorAll('[data-resume-section-unit], [data-resume-skills-category]'),
              ) as HTMLElement[]
              const visibleUnit = units.find(u => {
                const r = u.getBoundingClientRect()
                return r.bottom > viewportRect.top + 1 && r.top < viewportRect.bottom - 1
              })
              if (!visibleUnit) return

              const headerBottom = h2Rect.bottom + mb
              const unitTop = visibleUnit.getBoundingClientRect().top

              out.push({
                pageIdx,
                sectionId,
                useCont: false,
                gapToMarginPx: Math.round((unitTop - headerBottom) * 10) / 10,
                straddlers: [],
                flowHeaderDisplay: getComputedStyle(flowHeader).display,
                flowHeaderVisibility: getComputedStyle(flowHeader).visibility,
                contMinHeight: contHdr?.style.minHeight ?? null,
              })
            })
          })
        return out
      }, SUBPIXEL_TOLERANCE_PX)) as GapRow[]

      // eslint-disable-next-line no-console
      console.log('PREVIEW_GAP_EVIDENCE', JSON.stringify(rows, null, 2))

      expect(rows.length).toBeGreaterThan(0)
      const contRows = rows.filter(r => r.useCont)
      const inflowRows = rows.filter(r => !r.useCont)
      expect(contRows.length).toBeGreaterThan(0)
      for (const row of inflowRows) {
        expect(row.gapToMarginPx).not.toBeNull()
        expect(row.gapToMarginPx!).toBeGreaterThanOrEqual(0)
      }
      for (const row of contRows) {
        expect(row.flowHeaderDisplay).not.toBe('none')
        expect(row.flowHeaderVisibility).toBe('hidden')
        expect(row.gapToMarginPx).not.toBeNull()
        expect(row.straddlers, `page ${row.pageIdx} has text bisected by the header`).toEqual([])
      }
    } finally {
      await page.close()
    }
  }, 90000)
})
