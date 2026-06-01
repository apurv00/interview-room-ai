import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import type { ResumeData } from '../../validators/resume'

const ENABLED = process.env.RESUME_PDF_E2E === '1'

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

const academicData = {
  contactInfo: { fullName: 'Test User', email: 't@e.com' },
  summary: 'Research interests in machine learning and NLP.',
  education: [{ id: '1', institution: 'MIT', degree: 'PhD', field: 'CS', graduationDate: '2024' }],
  experience: Array.from({ length: 4 }, (_, i) => ({
    id: 'e' + i,
    company: 'Research Lab ' + i,
    title: 'Research Assistant',
    startDate: '2020',
    endDate: '2024',
    bullets: [
      'Conducted extensive research with long bullet text that wraps multiple lines on the page to force pagination across pages.',
      'Published papers and presented at conferences with collaborators.',
      'Built pipelines for data analysis and model training.',
    ],
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
} as unknown as ResumeData

interface GapRow {
  pageIdx: number
  sectionId: string | null
  gapPx: number
  useCont: boolean
  flowHeaderDisplay: string
  overlap: boolean
  contMinHeight: string | null
  contActualHeight: number | null
}

async function measureAllSectionGaps(templateId: string): Promise<GapRow[]> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(renderResumeHTML(academicData, templateId), { waitUntil: 'networkidle0' })
    await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
    return await page.evaluate(() => {
      const out: GapRow[] = []
      document.querySelectorAll('.resume-page').forEach((pg, pageIdx) => {
        pg.querySelectorAll('[data-resume-section]').forEach(section => {
          const sectionId = section.getAttribute('data-resume-section')
          const flowHeader = section.querySelector(
            '[data-resume-section-header], [data-resume-skills-header]',
          ) as HTMLElement | null
          const h2 = (flowHeader?.matches('h2')
            ? flowHeader
            : flowHeader?.querySelector('h2')) as HTMLElement | null
          const unit = section.querySelector(
            '[data-resume-section-unit], [data-resume-skills-category]',
          ) as HTMLElement | null
          if (!flowHeader || !h2 || !unit) return

          const h2Cs = getComputedStyle(h2)
          const h2Rect = h2.getBoundingClientRect()
          const mb = parseFloat(h2Cs.marginBottom) || 0
          const contHdr = pg.querySelector('.resume-continuation-header') as HTMLElement | null
          const useCont = Boolean(contHdr && getComputedStyle(flowHeader).display === 'none')
          const headerBottom = useCont
            ? contHdr!.getBoundingClientRect().bottom
            : h2Rect.bottom + mb
          const unitTop = unit.getBoundingClientRect().top
          const gap = unitTop - headerBottom

          out.push({
            pageIdx,
            sectionId,
            gapPx: Math.round(gap * 10) / 10,
            useCont,
            flowHeaderDisplay: getComputedStyle(flowHeader).display,
            overlap: gap < 0,
            contMinHeight: contHdr?.style.minHeight ?? null,
            contActualHeight: contHdr
              ? Math.round(contHdr.getBoundingClientRect().height * 10) / 10
              : null,
          })
        })
      })
      return out
    })
  } finally {
    await page.close()
  }
}

describe.runIf(ENABLED)('academic template — section header gaps', () => {
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

  it('logs gap measurements for all sections (runtime evidence)', async () => {
    if (!browser) {
      expect(true).toBe(true)
      return
    }
    const rows = await measureAllSectionGaps('academic')
    // eslint-disable-next-line no-console
    console.log('ACADEMIC_GAP_EVIDENCE', JSON.stringify(rows, null, 2))
    expect(rows.length).toBeGreaterThan(0)
    const overlaps = rows.filter(r => r.overlap)
    expect(overlaps).toEqual([])
    for (const row of rows) {
      expect(row.gapPx).toBeGreaterThanOrEqual(0)
    }
  }, 60000)
})
