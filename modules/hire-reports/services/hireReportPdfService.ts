import { createElement } from 'react'
import { HireJobCloseoutReport } from '../components/HireJobCloseoutReport'
import { HirePipelineStatusReport } from '../components/HirePipelineStatusReport'
import type { HireReportKind, HireReportSnapshot } from '../types'

const SYSTEM_CHROMIUM_ARGS = ['--no-sandbox', '--disable-setuid-sandbox']

export interface ChromiumLaunch {
  executablePath: string
  args: string[]
}

export interface HireReportPdfDependencies {
  resolveLaunch?: () => Promise<ChromiumLaunch>
  renderHtml?: (html: string, launch: ChromiumLaunch) => Promise<Buffer>
}

function htmlShell(content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hire report</title>
    <style>
      @page { size: A4; margin: 16mm; }
      :root { color: #16202a; font-family: Arial, Helvetica, sans-serif; }
      body { margin: 0; color: #16202a; font-size: 10.5pt; line-height: 1.45; }
      article { max-width: 760px; margin: 0 auto; }
      article > header { border-bottom: 2px solid #1d9bf0; margin-bottom: 20px; padding-bottom: 14px; }
      .hire-report-eyebrow { color: #526471; font-size: 9pt; font-weight: 700; letter-spacing: .09em; margin: 0 0 6px; text-transform: uppercase; }
      h1 { font-size: 25pt; line-height: 1.1; margin: 0; }
      h2 { font-size: 15pt; margin: 0 0 8px; }
      h3 { font-size: 12pt; margin: 0 0 6px; }
      h4 { font-size: 10.5pt; margin: 0 0 3px; }
      section { margin: 0 0 20px; }
      h2, h3, h4 { break-after: avoid; }
      .hire-report-job { border-bottom: 1px solid #dbe5ec; padding-bottom: 18px; }
      .hire-report-job > header { margin-bottom: 14px; }
      .hire-report-job > header h2 { margin-bottom: 2px; }
      p { margin: 4px 0 10px; }
      table { border-collapse: collapse; margin: 8px 0; width: 100%; }
      th, td { border-bottom: 1px solid #dbe5ec; padding: 6px 5px; text-align: left; vertical-align: top; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      thead th { color: #526471; font-size: 9pt; }
      th[scope="row"] { text-transform: capitalize; }
      ul { margin: 6px 0; padding-left: 20px; }
      .hire-report-evidence { background: #f4f8fb; border-radius: 6px; break-inside: avoid; padding: 12px; }
      .hire-report-evidence > div { border-top: 1px solid #dbe5ec; margin-top: 10px; padding-top: 10px; }
      .hire-report-recommendation-tally { display: grid; gap: 5px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 8px 0 0; }
      .hire-report-recommendation-tally div { background: #fff; border-radius: 4px; padding: 5px; }
      .hire-report-recommendation-tally dt { color: #526471; font-size: 8pt; }
      .hire-report-recommendation-tally dd { font-size: 13pt; font-weight: 700; margin: 1px 0 0; }
      footer { border-top: 1px solid #dbe5ec; color: #526471; font-size: 9pt; margin-top: 24px; padding-top: 10px; }
    </style>
  </head>
  <body>${content}</body>
</html>`
}

/** A safe HTML representation used by the private PDF worker and renderer tests. */
export function renderHireReportHtml(snapshot: HireReportSnapshot): string {
  const reactDomServer = require('react-dom/server') as typeof import('react-dom/server')
  const content = snapshot.kind === 'pipeline_status'
    ? reactDomServer.renderToStaticMarkup(createElement(HirePipelineStatusReport, { snapshot }))
    : reactDomServer.renderToStaticMarkup(createElement(HireJobCloseoutReport, { snapshot }))
  return htmlShell(content)
}

/** Resolve a production or local Chromium executable without importing B2C PDF code. */
export async function resolveHireReportChromiumLaunch(
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

/** Render only a frozen, deep-allowlisted report snapshot. */
export async function generateHireReportPdf(
  snapshot: HireReportSnapshot,
  dependencies: HireReportPdfDependencies = {},
): Promise<Buffer> {
  const html = renderHireReportHtml(snapshot)
  const launch = await (dependencies.resolveLaunch ?? resolveHireReportChromiumLaunch)()
  return (dependencies.renderHtml ?? renderHtmlToPdf)(html, launch)
}

/** Avoid candidate names, workspace names, and user-controlled text in filenames. */
export function hireReportPdfFilename(kind: HireReportKind): string {
  return kind === 'pipeline_status' ? 'pipeline-status-report.pdf' : 'job-closeout-report.pdf'
}
