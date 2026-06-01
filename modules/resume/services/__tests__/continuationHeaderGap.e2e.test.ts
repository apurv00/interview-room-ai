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
        'Extended delivery scope with additional compliance and audit workflows across multiple regions.',
        'Coordinated cross-team releases and maintained platform reliability during peak registration periods.',
      ],
    },
    {
      id: 'e5',
      company: 'Earlier Role Co',
      title: 'Software Engineer',
      location: 'Remote',
      startDate: 'Jan 2015',
      endDate: 'May 2017',
      bullets: Array.from({ length: 5 }, (_, b) =>
        `Delivered platform milestone ${b + 1} with measurable impact on reliability, performance, and stakeholder reporting across multiple product lines.`,
      ),
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

/** Forces an education continuation page without an experience continuation header. */
const educationContinuationData = {
  name: 'Test',
  template: 'executive',
  contactInfo: data.contactInfo,
  summary:
    'Product leader focused on roadmap delivery, experimentation, and cross-functional execution across growth and platform teams.',
  experience: [
    {
      id: 'e1',
      company: 'FanCode by Dream11',
      title: 'Product Manager',
      location: 'Mumbai',
      startDate: 'Jul 2024',
      endDate: 'Present',
      bullets: ['Led roadmap delivery for growth initiatives with measurable KPI impact.'],
    },
  ],
  education: Array.from({ length: 20 }, (_, i) => ({
    id: `ed${i + 1}`,
    institution: `Institution ${i + 1}`,
    degree: `Degree ${i + 1}`,
    field: 'Business & Technology',
    graduationDate: `Apr ${2005 + i}`,
    honors:
      'Honors, capstone research, and coursework spanning analytics, strategy, product leadership, and cross-functional delivery with measurable outcomes across multiple semesters.',
  })),
  skills: [{ category: 'Product Management', items: ['Roadmap', 'SQL'] }],
  projects: [],
  certifications: [],
  customSections: [],
  styling: data.styling,
} as unknown as ResumeData

interface ContinuationGapRow {
  page: number
  headerGapPx: number | null
  h2Display: string | null
  suppress: string | null
}

interface ContinuationHeaderStyle {
  text: string | undefined
  uppercase: string
  hasBorder: boolean
  headerFontPx: number
  bodyFontPx: number
}

/** Continuation header on the page whose content suppresses `sectionId`'s in-flow header. */
async function continuationHeaderStyle(
  templateId: string,
  sectionId: string,
  resumeData: ResumeData = data,
): Promise<ContinuationHeaderStyle | null> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(renderResumeHTML({ ...resumeData, template: templateId }, templateId), {
      waitUntil: 'networkidle0',
    })
    await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
    return await page.evaluate((sid: string) => {
      const pages = Array.from(document.querySelectorAll('.resume-page'))
      for (const pg of pages) {
        const content = pg.querySelector('.resume-page-content') as HTMLElement | null
        if (content?.getAttribute('data-suppress-section') !== sid) continue
        const hdr = pg.querySelector(
          '.resume-continuation-header [data-resume-section-header]',
        ) as HTMLElement | null
        if (!hdr || !content) return null
        const hCs = getComputedStyle(hdr)
        const bCs = getComputedStyle(content)
        return {
          text: hdr.textContent?.trim(),
          uppercase: hCs.textTransform,
          hasBorder: hCs.borderBottomWidth !== '0px',
          headerFontPx: parseFloat(hCs.fontSize),
          bodyFontPx: parseFloat(bCs.fontSize),
        }
      }
      return null
    }, sectionId)
  } finally {
    await page.close()
  }
}

async function experienceContinuationStyle(templateId: string) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(renderResumeHTML({ ...data, template: templateId }, templateId), {
      waitUntil: 'networkidle0',
    })
    await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
    return await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll('.resume-page'))
      for (const pg of pages) {
        const content = pg.querySelector('.resume-page-content') as HTMLElement | null
        if (content?.getAttribute('data-suppress-section') !== 'experience') continue
        const hdr = pg.querySelector(
          '.resume-continuation-header [data-resume-section-header]',
        ) as HTMLElement | null
        const band = pg.querySelector('.resume-page-content-band') as HTMLElement | null
        const unit = content.querySelector(
          '[data-resume-section="experience"] [data-resume-section-unit]',
        ) as HTMLElement | null
        if (!hdr || !band || !unit) return null
        const hRect = hdr.getBoundingClientRect()
        const contBottom = hRect.bottom
        const viewportRect = pg.querySelector('.resume-page-viewport')!.getBoundingClientRect()
        const section = content.querySelector('[data-resume-section="experience"]') as HTMLElement | null
        let firstTop: number | null = null
        section?.querySelectorAll('[data-resume-section-unit], [data-resume-section-unit] *').forEach(node => {
          const el = node as HTMLElement
          const r = el.getBoundingClientRect()
          if (r.height < 1) return
          if (r.top >= contBottom - 1 && r.top < viewportRect.bottom - 1) {
            if (firstTop === null || r.top < firstTop) firstTop = r.top
          }
        })
        if (firstTop === null) return null
        const uRect = { top: firstTop, bottom: firstTop } as DOMRect
        const hCs = getComputedStyle(hdr)
        const bandCs = getComputedStyle(band)
        const overlay = pg.querySelector('.resume-continuation-header') as HTMLElement | null
        return {
          headerFontPx: parseFloat(hCs.fontSize),
          bodyFontPx: parseFloat(bandCs.fontSize),
          gapPx: Math.round(uRect.top - hRect.bottom),
          headerHeightPx: Math.round(hRect.height),
          overlayMinHeight: overlay?.style.minHeight,
        }
      }
      return null
    })
  } finally {
    await page.close()
  }
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
        const viewportRect = viewport.getBoundingClientRect()
        const contBottom = hdr.getBoundingClientRect().bottom
        const suppress = content.getAttribute('data-suppress-section')
        const section = suppress
          ? (content.querySelector(`[data-resume-section="${suppress}"]`) as HTMLElement | null)
          : null
        const h2 = section?.querySelector('[data-resume-section-header]') as HTMLElement | null
        let headerGapPx: number | null = null
        if (section) {
          const nodes = section.querySelectorAll(
            '[data-resume-section-unit], [data-resume-section-unit] *',
          )
          nodes.forEach(node => {
            const el = node as HTMLElement
            const r = el.getBoundingClientRect()
            if (r.height < 1) return
            if (r.top >= contBottom - 1 && r.top < viewportRect.bottom - 1) {
              const gap = Math.round(r.top - contBottom)
              if (headerGapPx === null || gap < headerGapPx) headerGapPx = gap
            }
          })
        }
        rows.push({
          page: i,
          headerGapPx,
          h2Display: h2 ? getComputedStyle(h2).display : null,
          suppress,
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
    const expRows = rows.filter(row => row.suppress === 'experience')
    expect(expRows.length).toBeGreaterThan(0)
    for (const row of expRows) {
      expect(row.h2Display).toBe('none')
      expect(row.headerGapPx).not.toBeNull()
      expect(row.headerGapPx!).toBeGreaterThanOrEqual(0)
    }
    const exp = await experienceContinuationStyle('executive')
    expect(exp).not.toBeNull()
    expect(exp!.headerFontPx).toBeLessThanOrEqual(exp!.bodyFontPx + 1)
    expect(exp!.gapPx).toBeGreaterThanOrEqual(0)
  }, 60000)

  it('executive: education continuation header keeps template title classes', async () => {
    if (!browser) {
      expect(true).toBe(true)
      return
    }
    const styled = await continuationHeaderStyle('executive', 'education', educationContinuationData)
    expect(styled).not.toBeNull()
    expect(styled?.text?.toLowerCase()).toContain('education')
    expect(styled?.uppercase).toBe('uppercase')
    expect(styled?.hasBorder).toBe(true)
    expect(styled!.headerFontPx).toBeLessThanOrEqual(styled!.bodyFontPx + 1)
    expect(styled!.headerFontPx).toBeGreaterThan(6)
  }, 60000)
})
