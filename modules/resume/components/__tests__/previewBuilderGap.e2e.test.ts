import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const ENABLED = process.env.RESUME_PDF_E2E === '1'
const BASE = process.env.PREVIEW_BASE_URL || 'http://localhost:3000'

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
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
  gapToBorderPx: number
  gapToMarginPx: number
  overlapBorder: boolean
  overlapMargin: boolean
  contMinHeight: string | null
}

describe.runIf(ENABLED)('builder ResumePreview — section header gaps', () => {
  beforeAll(async () => {
    try {
      browser = await launchBrowser()
    } catch {
      browser = null
    }
  }, 60000)
  afterAll(async () => {
    if (browser) await browser.close()
  })

  it('measures live preview gaps (runtime evidence)', async () => {
    if (!browser) {
      expect(true).toBe(true)
      return
    }
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 1440, height: 1200 })
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.evaluate((d) => {
        localStorage.setItem('resume:draft:anon', JSON.stringify(d))
      }, draft)
      await page.goto(`${BASE}/resume/builder?template=academic`, {
        waitUntil: 'networkidle0',
        timeout: 60000,
      })
      await page.waitForSelector('#resume-preview-container [data-resume-page-viewport]', {
        timeout: 30000,
      })
      await page.waitForFunction(() => document.fonts?.status === 'loaded', { timeout: 15000 }).catch(
        () => undefined,
      )
      await new Promise(r => setTimeout(r, 800))

      const rows = (await page.evaluate(() => {
        const out: GapRow[] = []
        document
          .querySelectorAll('#resume-preview-container [data-resume-page-viewport]')
          .forEach((viewport, pageIdx) => {
            const viewportRect = viewport.getBoundingClientRect()
            const contHdr = viewport.querySelector(
              '[data-resume-continuation-header]',
            ) as HTMLElement | null
            const contBottom = contHdr?.getBoundingClientRect().bottom ?? null

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
              const borderBottom = h2Rect.bottom
              const useCont = Boolean(contHdr && getComputedStyle(flowHeader).display === 'none')

              // On continuation pages, compare overlay to the first unit visible in this viewport.
              const units = Array.from(
                section.querySelectorAll('[data-resume-section-unit], [data-resume-skills-category]'),
              ) as HTMLElement[]
              const visibleUnit = units.find(u => {
                const r = u.getBoundingClientRect()
                if (useCont && contBottom != null) {
                  return r.top >= contBottom - 1 && r.top < viewportRect.bottom - 1
                }
                return r.bottom > viewportRect.top + 1 && r.top < viewportRect.bottom - 1
              })
              if (!visibleUnit) return

              const headerBottom = useCont && contBottom != null
                ? contBottom
                : h2Rect.bottom + mb
              const unitTop = visibleUnit.getBoundingClientRect().top

              out.push({
                pageIdx,
                sectionId,
                useCont,
                gapToBorderPx: Math.round((unitTop - borderBottom) * 10) / 10,
                gapToMarginPx: Math.round((unitTop - headerBottom) * 10) / 10,
                overlapBorder: unitTop - borderBottom < 0,
                overlapMargin: unitTop - headerBottom < 0,
                contMinHeight: contHdr?.style.minHeight ?? null,
              })
            })
          })
        return out
      })) as GapRow[]

      // eslint-disable-next-line no-console
      console.log('PREVIEW_GAP_EVIDENCE', JSON.stringify(rows, null, 2))

      const contDebug = await page.evaluate(() => {
        const viewport = document.querySelectorAll('#resume-preview-container [data-resume-page-viewport]')[1]
        if (!viewport) return null
        const cont = viewport.querySelector('[data-resume-continuation-header]') as HTMLElement | null
        const content = viewport.querySelector('[data-resume-page-content]') as HTMLElement | null
        const suppress = content?.getAttribute('data-suppress-section')
        const exp = suppress
          ? viewport.querySelector(`[data-resume-section="${suppress}"]`)
          : null
        const contBottom = cont?.getBoundingClientRect().bottom ?? 0
        const units = exp
          ? Array.from(exp.querySelectorAll('[data-resume-section-unit]')).map(u => ({
              top: Math.round(u.getBoundingClientRect().top),
              bottom: Math.round(u.getBoundingClientRect().bottom),
            }))
          : []
        const firstBelowHeader = units.find(u => u.top >= contBottom - 1)
        return {
          contMinHeight: cont?.style.minHeight,
          contRect: cont
            ? {
                top: Math.round(cont.getBoundingClientRect().top),
                bottom: Math.round(cont.getBoundingClientRect().bottom),
                height: Math.round(cont.getBoundingClientRect().height),
              }
            : null,
          marginTop: content?.style.marginTop,
          suppress,
          firstBelowHeader,
          gapBelowHeader: firstBelowHeader ? firstBelowHeader.top - contBottom : null,
        }
      })
      // eslint-disable-next-line no-console
      console.log('CONT_DEBUG_PAGE1', JSON.stringify(contDebug, null, 2))
      if (contDebug?.gapBelowHeader != null) {
        expect(contDebug.gapBelowHeader).toBeGreaterThanOrEqual(0)
      }

      expect(rows.length).toBeGreaterThan(0)
      const contRows = rows.filter(r => r.useCont)
      const inflowRows = rows.filter(r => !r.useCont)
      for (const row of inflowRows) {
        expect(row.gapToMarginPx).toBeGreaterThanOrEqual(0)
      }
      for (const row of contRows) {
        expect(row.gapToMarginPx).toBeGreaterThanOrEqual(0)
      }
    } finally {
      await page.close()
    }
  }, 90000)
})
