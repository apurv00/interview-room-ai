import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderResumeHTML } from '../pdfService'
import type { ResumeData } from '../../validators/resume'

/**
 * Real-Chromium regression lock for the line-snap pagination fix.
 *
 * Bug: when a section straddled a page break, the paginator cut at a raw pixel
 * offset that bisected a text line. The half-line bled onto the prior page and
 * reappeared clipped under the repeated section header on the continuation page
 * (reported on Technical; reproduced on professional/modern/executive/
 * career-change/entry-level too — it was in the SHARED paginator).
 *
 * This asserts, for every family, that on a forced 2-page render NO content row
 * straddles a continuation viewport's top edge (top < 0 && bottom > 0) — i.e.
 * breaks land on line boundaries. Opt-in (RESUME_PDF_E2E=1); skips if the
 * browser can't launch so the browser-free `ci` job stays green.
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

// Long-bullet data that forces a 2-page render with Experience straddling the
// break across every family. bodySize 12 guarantees the overflow in jsdom-free
// real layout regardless of small per-family geometry differences.
const data = {
  name: 'Test', template: 'technical',
  contactInfo: { fullName: 'Apurv Abhishek', email: 'a@b.c', phone: '9304906486', location: 'Mumbai', linkedin: 'linkedin.com/in/x' },
  summary: 'Data-driven Product Manager with experience defining product roadmaps, driving cross-functional delivery, and translating ambiguous problems into clear product solutions across web and app platforms. Proven track record of working in agile environments with engineering, design, and GTM teams to ship impactful products.',
  experience: [
    { id: 'e1', company: 'FanCode by Dream11', title: 'Product Manager', location: 'Mumbai', startDate: 'Jul 2024', endDate: 'Present', bullets: ['Led end-to-end product roadmap and strategy for growth initiatives, defining KPIs and iterating rapidly based on data, driving 400K new users and a 7% revenue increase through SDK integration with strategic partners, achieving 55%+ retention.', 'Wrote clear product requirements and acceptance criteria for engineering teams to revamp web architecture, making it crawler-friendly and contributing to a 57% increase in organic traffic driven by non-branded keywords.', 'Conducted user research and competitive analysis to redesign onboarding experience, resulting in a 35% uplift in first-day new user conversion within 3 months of launch.', 'Prioritized backlog and managed trade-offs across cross-functional teams to revamp the website, reducing bounce rate by 18% and increasing top-of-funnel conversion from 53% to 65%.'] },
    { id: 'e2', company: 'Swiggy', title: 'Product Manager', location: 'Bengaluru', startDate: 'May 2022', endDate: 'Jul 2024', bullets: ['Defined and executed product roadmap for Swiggy Minis (0-to-1), translating ambiguous small-seller needs into a clear digital storefront solution with onboarding time under 5 minutes, collaborating daily with engineering, design, and GTM teams.', 'Led product-led partnership strategy for logistics and marketing integrations (Shippigo, Shiprocket, Shadowfax, META APIs), achieving a 75% increase in integrated feature consumption and turning integrations into a scalable demand channel.', 'Tracked product KPIs and iterated on in-app real-time communication features, resulting in a 35% increase in customer satisfaction scores across the platform.', 'Conducted customer interviews and competitive analysis to synthesize learnings and inform strategic roadmaps aligned with business objectives, presenting recommendations to leadership.'] },
    { id: 'e3', company: 'Signzy', title: 'Associate Product Manager', location: 'Bengaluru', startDate: 'May 2021', endDate: 'May 2022', bullets: ['Defined requirements and managed end-to-end delivery of a no-code automation platform for customer onboarding digitization, working cross-functionally with engineering teams in an agile environment to digitize operations without code.', 'Tracked KPIs and iterated on automation and API-driven features, achieving an 80% reduction in onboarding time and a 90% reduction in data error rates, significantly lowering operational costs.'] },
    { id: 'e4', company: 'Volt Technologies', title: 'Software Engineer', location: 'Ranchi', startDate: 'Jun 2017', endDate: 'Jun 2019', bullets: ['Developed e-SDCD, an innovative licensing system for medicine manufacturing for the Government of Jharkhand, reducing license grant time from 6 months to 1 month.', 'Led Single Window System API integration for the e-SDCD portal, gaining foundational experience in building scalable integrations and developer-facing systems.'] },
  ],
  education: [
    { id: 'ed1', institution: 'IIM Trichy', degree: 'Master of Business Administration', field: 'Marketing & Strategy', graduationDate: 'Apr 2021', gpa: '4.0 / 4.0' },
    { id: 'ed2', institution: 'Biju Patnaik University of Technology', degree: 'Bachelor of Technology', field: 'Computer Science', graduationDate: 'Apr 2017', gpa: '7.22 / 10' },
  ],
  skills: [{ category: 'Product Management', items: ['Roadmap', 'Backlog', 'KPIs', 'Research', 'A/B Testing', 'SQL', 'Stakeholder Mgmt', 'Analytics'] }],
  projects: [], certifications: [], customSections: [],
  styling: { fontFamily: 'georgia', headingSize: 18, bodySize: 12 },
} as unknown as ResumeData

// Single-column families get the STRICT guarantee: a break never bisects a
// line, so zero rows may straddle a continuation page top.
const SINGLE_COLUMN_FAMILIES = [
  'technical',       // Technical family (originally reported)
  'professional',    // Classic
  'modern-indigo',   // Modern
  'executive',       // Executive
  'career-change',   // Career Change
  'entry-level',     // Early Career
]

// Columnar Sidebar (Creative + variants) is height-sliced as one atomic block
// per TEMPLATE_PAGINATION.md ("coarser pagination ... is expected"): the two
// columns' line boundaries don't align, so a single break offset can't clear a
// line in BOTH columns. Line-snapping still reduces the clip; we assert it is
// bounded (≤ one line) rather than zero, and track perfect columnar line-snap
// as a follow-up.
const COLUMNAR_FAMILIES = ['creative']

async function straddlingRows(templateId: string): Promise<Array<{ page: number; txt: string; top: number }>> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123 })
    await page.setContent(renderResumeHTML({ ...data, template: templateId }, templateId), { waitUntil: 'networkidle0' })
    await page.waitForFunction(() => (window as any).__resumePagesReady === true, { timeout: 15000 })
    return await page.evaluate(() => {
      const root = document.getElementById('resume-pages-root')!
      const pages = Array.from(root.querySelectorAll('.resume-page'))
      const bad: Array<{ page: number; txt: string; top: number }> = []
      pages.forEach((pg, i) => {
        const viewport = pg.querySelector('.resume-page-viewport') as HTMLElement | null
        const content = pg.querySelector('.resume-page-content') as HTMLElement | null
        if (!viewport || !content) return
        const vTop = viewport.getBoundingClientRect().top
        const vH = viewport.getBoundingClientRect().height
        const isLastPage = i === pages.length - 1
        // The continuation-header overlay is an OPAQUE band that masks the
        // re-shown [breakTop−headerHeight, breakTop] slice at the top of the
        // page. A line whose bottom falls within that masked band is not
        // visible to the user, so it must not count as an overlap.
        const hdr = pg.querySelector('.resume-continuation-header') as HTMLElement | null
        const maskBottom = hdr ? hdr.getBoundingClientRect().bottom - vTop : 0
        // Measure at LINE granularity (one rect per visual line via Range), not
        // element boxes: a multi-line bullet may legitimately split BETWEEN its
        // own wrapped lines across a page (no line cut), which a box-level check
        // would falsely flag. The real defect is an individual LINE bisected by
        // the viewport top (the reported overlap) or bottom (a clipped tail).
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const txt = (node.textContent || '').trim()
          if (txt.length > 0) {
            const range = document.createRange()
            range.selectNodeContents(node)
            const rects = Array.from(range.getClientRects())
            for (const rc of rects) {
              if (rc.height <= 0) continue
              const top = rc.top - vTop
              const bottom = rc.bottom - vTop
              // A single line bisected by the TOP edge (reported overlap) AND
              // not hidden behind the opaque continuation-header band. If the
              // line's visible bottom is within the mask, the user never sees it.
              if (top < -2 && bottom > maskBottom + 2 && bottom < vH - 2) {
                bad.push({ page: i, txt: txt.slice(0, 40), top: Math.round(top) })
              }
              // A single line bisected by the BOTTOM edge of a non-final page
              // (tail clipped after a snapped boundary break — Codex r3333970641).
              if (!isLastPage && top > 2 && top < vH - 2 && bottom > vH + 2) {
                bad.push({ page: i, txt: txt.slice(0, 40), top: Math.round(top) })
              }
            }
          }
          node = walker.nextNode()
        }
      })
      return bad
    })
  } finally {
    await page.close()
  }
}

describe.runIf(ENABLED)('pagination line-snap — no row straddles a page top (all families)', () => {
  beforeAll(async () => {
    try { browser = await launchBrowser() } catch { browser = null }
  }, 60000)
  afterAll(async () => { if (browser) await browser.close() })

  for (const templateId of SINGLE_COLUMN_FAMILIES) {
    it(`${templateId}: no half-clipped line at any continuation page top`, async () => {
      if (!browser) { expect(true).toBe(true); return } // env can't launch → skip soft
      const bad = await straddlingRows(templateId)
      if (bad.length) {
        // eslint-disable-next-line no-console
        console.log(`STRADDLE ${templateId}`, JSON.stringify(bad))
      }
      expect(bad).toEqual([])
    }, 60000)
  }

  for (const templateId of COLUMNAR_FAMILIES) {
    it(`${templateId} (columnar): clipping is bounded to at most one line`, async () => {
      if (!browser) { expect(true).toBe(true); return }
      const bad = await straddlingRows(templateId)
      if (bad.length) {
        // eslint-disable-next-line no-console
        console.log(`STRADDLE ${templateId}`, JSON.stringify(bad))
      }
      // Height-sliced columns can't align both columns' lines; assert the clip
      // is small (≤ ~1.5 lines ≈ 36px) rather than the old raw-pixel cut, and
      // never more than one straddling row.
      expect(bad.length).toBeLessThanOrEqual(1)
      for (const row of bad) {
        expect(Math.abs(row.top)).toBeLessThanOrEqual(36)
      }
    }, 60000)
  }
})
