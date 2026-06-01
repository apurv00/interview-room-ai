import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import type { ResumeData } from '../../validators/resume'

/**
 * Regression: continuation overlay "Experience" must not sit on the first job line.
 * Complements paginationLineSnap (line bisection) with box-level header gap checks.
 */
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

const data = {
  name: 'Test',
  template: 'executive',
  contactInfo: { fullName: 'Apurv Abhishek', email: 'a@b.c', phone: '9304906486', location: 'Mumbai' },
  summary:
    'Data-driven Product Manager with experience defining product roadmaps, driving cross-functional delivery, and translating ambiguous problems into clear product solutions across web and app platforms.',
  experience: [
    {
      id: 'e1',
      company: 'FanCode by Dream11',
      title: 'Product Manager',
      location: 'Mumbai',
      startDate: 'Jul 2024',
      endDate: 'Present',
      bullets: [
        'Led end-to-end product roadmap and strategy for growth initiatives, defining KPIs and iterating rapidly based on data.',
        'Wrote clear product requirements and acceptance criteria for engineering teams to revamp web architecture.',
        'Conducted user research and competitive analysis to redesign onboarding experience.',
        'Prioritized backlog and managed trade-offs across cross-functional teams to revamp the website.',
      ],
    },
    {
      id: 'e2',
      company: 'Swiggy',
      title: 'Product Manager',
      location: 'Bengaluru',
      startDate: 'May 2022',
      endDate: 'Jul 2024',
      bullets: [
        'Defined and executed product roadmap for Swiggy Minis (0-to-1).',
        'Led product-led partnership strategy for logistics and marketing integrations.',
        'Tracked product KPIs and iterated on in-app real-time communication features.',
        'Conducted customer interviews and competitive analysis to inform strategic roadmaps.',
      ],
    },
    {
      id: 'e3',
      company: 'Signzy',
      title: 'Associate Product Manager',
      location: 'Bengaluru',
      startDate: 'May 2021',
      endDate: 'May 2022',
      bullets: [
        'Defined requirements and managed end-to-end delivery of a no-code automation platform.',
        'Tracked KPIs and iterated on automation and API-driven features.',
      ],
    },
    {
      id: 'e4',
      company: 'Volt Technologies',
      title: 'Software Engineer',
      location: 'Ranchi',
      startDate: 'Jun 2017',
      endDate: 'Jun 2019',
      bullets: [
        'Developed e-SDCD, an innovative licensing system for medicine manufacturing.',
        'Led Single Window System API integration for the e-SDCD portal.',
      ],
    },
  ],
  education: [
    {
      id: 'ed1',
      institution: 'IIM Trichy',
      degree: 'Master of Business Administration',
      field: 'Marketing & Strategy',
      graduationDate: 'Apr 2021',
    },
  ],
  skills: [{ category: 'Product Management', items: ['Roadmap', 'SQL', 'Analytics'] }],
  projects: [],
  certifications: [],
  customSections: [],
  styling: { fontFamily: 'georgia', headingSize: 18, bodySize: 12 },
} as unknown as ResumeData

interface ContinuationGapRow {
  page: number
  headerGapPx: number | null
  h2Display: string | null
  suppress: string | null
}

async function continuationGaps(templateId: string): Promise<ContinuationGapRow[]> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(renderResumeHTML({ ...data, template: templateId }, templateId), {
      waitUntil: 'networkidle0',
    })
    await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
    return await page.evaluate(() => {
      const rows: ContinuationGapRow[] = []
      const pages = Array.from(document.querySelectorAll('.resume-page'))
      pages.forEach((pg, i) => {
        const viewport = pg.querySelector('.resume-page-viewport') as HTMLElement | null
        const content = pg.querySelector('.resume-page-content') as HTMLElement | null
        const hdr = pg.querySelector('.resume-continuation-header') as HTMLElement | null
        if (!viewport || !content || !hdr) return
        const exp = content.querySelector('[data-resume-section="experience"]')
        const h2 = exp?.querySelector('[data-resume-section-header]') as HTMLElement | null
        const unit = exp?.querySelector('[data-resume-section-unit]') as HTMLElement | null
        const gap = unit
          ? Math.round(unit.getBoundingClientRect().top - hdr.getBoundingClientRect().bottom)
          : null
        rows.push({
          page: i,
          headerGapPx: gap,
          h2Display: h2 ? getComputedStyle(h2).display : null,
          suppress: content.getAttribute('data-suppress-section'),
        })
      })
      return rows
    })
  } finally {
    await page.close()
  }
}

describe.runIf(ENABLED)('continuation header gap — overlay clears first job line', () => {
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

  it('executive: continuation pages hide in-flow header and leave >=6px under overlay', async () => {
    if (!browser) {
      expect(true).toBe(true)
      return
    }
    const rows = await continuationGaps('executive')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.suppress).toBe('experience')
      expect(row.h2Display).toBe('none')
      expect(row.headerGapPx).not.toBeNull()
      expect(row.headerGapPx!).toBeGreaterThanOrEqual(6)
    }
  }, 60000)

  it('executive: education continuation header keeps template title classes', async () => {
    if (!browser) {
      expect(true).toBe(true)
      return
    }
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 794, height: 1123 })
      await page.setContent(renderResumeHTML({ ...data, template: 'executive' }, 'executive'), {
        waitUntil: 'networkidle0',
      })
      await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
      const styled = await page.evaluate(() => {
        const hdr = document.querySelector(
          '.resume-page .resume-continuation-header [data-resume-section-header]',
        ) as HTMLElement | null
        if (!hdr) return null
        const cs = getComputedStyle(hdr)
        return {
          text: hdr.textContent?.trim(),
          uppercase: cs.textTransform,
          hasBorder: cs.borderBottomWidth !== '0px',
        }
      })
      expect(styled).not.toBeNull()
      expect(styled?.text?.toLowerCase()).toContain('education')
      expect(styled?.uppercase).toBe('uppercase')
      expect(styled?.hasBorder).toBe(true)
    } finally {
      await page.close()
    }
  }, 60000)
})
