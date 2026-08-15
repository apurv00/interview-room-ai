import { createElement } from 'react'
import type { HireDecisionView } from '../types'
import { HireAssessmentReport } from '../components/HireAssessmentReport'

const SYSTEM_CHROMIUM_ARGS = ['--no-sandbox', '--disable-setuid-sandbox']

export interface ChromiumLaunch {
  executablePath: string
  args: string[]
}

export interface HireAssessmentPdfDependencies {
  resolveLaunch?: () => Promise<ChromiumLaunch>
  renderHtml?: (html: string, launch: ChromiumLaunch) => Promise<Buffer>
}

function htmlShell(content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Candidate assessment</title>
    <style>
      @page { size: A4; margin: 18mm; }
      :root { color: #16202a; font-family: Arial, Helvetica, sans-serif; }
      body { margin: 0; color: #16202a; font-size: 11pt; line-height: 1.45; }
      .hire-assessment-report { max-width: 760px; margin: 0 auto; }
      .hire-assessment-report header { border-bottom: 2px solid #1d9bf0; margin-bottom: 22px; padding-bottom: 16px; }
      .hire-assessment-eyebrow { color: #526471; font-size: 9pt; font-weight: 700; letter-spacing: .09em; margin: 0 0 6px; text-transform: uppercase; }
      h1 { font-size: 27pt; line-height: 1.1; margin: 0; }
      h2 { font-size: 15pt; margin: 0 0 6px; }
      .hire-assessment-role { font-size: 14pt; margin: 5px 0; }
      .hire-assessment-meta, .hire-assessment-supporting { color: #526471; margin: 4px 0 12px; }
      section { break-inside: avoid; margin: 0 0 24px; }
      .hire-assessment-tally { display: grid; gap: 8px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 12px 0 16px; }
      .hire-assessment-tally div { background: #f4f8fb; border-radius: 6px; padding: 8px; }
      .hire-assessment-tally dt { color: #526471; font-size: 9pt; }
      .hire-assessment-tally dd { font-size: 18pt; font-weight: 700; margin: 1px 0 0; }
      .hire-assessment-dimensions { border-collapse: collapse; width: 100%; }
      .hire-assessment-dimensions th, .hire-assessment-dimensions td { border-bottom: 1px solid #dbe5ec; padding: 7px 5px; text-align: left; }
      .hire-assessment-dimensions th[scope="row"] { text-transform: capitalize; }
      .hire-assessment-ai-list { margin: 0; padding-left: 20px; }
      .hire-assessment-ai-list > li { break-inside: avoid; margin: 0 0 12px; }
      .hire-assessment-ai-list > li > div { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; }
      .hire-assessment-ai-list p { margin: 4px 0; }
      .hire-assessment-ai-list ul { margin: 4px 0; padding-left: 20px; }
      footer { border-top: 1px solid #dbe5ec; color: #526471; font-size: 9pt; margin-top: 26px; padding-top: 12px; }
    </style>
  </head>
  <body>${content}</body>
</html>`
}

/** A safe HTML representation used by both the PDF worker and renderer tests. */
export function renderHireAssessmentHtml(decision: HireDecisionView): string {
  // Dynamic require keeps this server-only rendering primitive out of browser
  // bundles and mirrors the established PDF route pattern.
  const reactDomServer = require('react-dom/server') as typeof import('react-dom/server')
  return htmlShell(reactDomServer.renderToStaticMarkup(createElement(HireAssessmentReport, { decision })))
}

/** Resolve a production or local Chromium executable without importing B2C PDF code. */
export async function resolveHireAssessmentChromiumLaunch(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChromiumLaunch> {
  if (env.CHROMIUM_PATH) {
    return { executablePath: env.CHROMIUM_PATH, args: SYSTEM_CHROMIUM_ARGS }
  }
  const chromium = require('@sparticuz/chromium') as {
    args: string[]
    executablePath: () => Promise<string>
  }
  return { executablePath: await chromium.executablePath(), args: chromium.args }
}

async function renderHtmlToPdf(html: string, launch: ChromiumLaunch): Promise<Buffer> {
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core')
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: launch.executablePath,
    args: launch.args,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }))
  } finally {
    await browser.close()
  }
}

/**
 * Render only the already-redacted decision DTO. Callers must authorize and
 * snapshot their data before invoking this external-process boundary.
 */
export async function generateHireAssessmentPdf(
  decision: HireDecisionView,
  dependencies: HireAssessmentPdfDependencies = {},
): Promise<Buffer> {
  const html = renderHireAssessmentHtml(decision)
  const launch = await (dependencies.resolveLaunch ?? resolveHireAssessmentChromiumLaunch)()
  return (dependencies.renderHtml ?? renderHtmlToPdf)(html, launch)
}

/** Avoid candidate names or user-controlled strings in attachment filenames. */
export function hireAssessmentPdfFilename(): string {
  return 'candidate-assessment.pdf'
}
