import { describe, expect, it } from 'vitest'
import { hireReportWorkbookQa } from './fixtures/reportWorkbookQa'
import {
  generateHireReportPdf,
  hireReportPdfFilename,
  renderHireReportHtml,
  resolveHireReportChromiumLaunch,
} from '../services/hireReportPdfService'

describe('Hire report PDF rendering', () => {
  it('renders only the frozen report snapshots and React-escapes safe prose', () => {
    const pipelineHtml = renderHireReportHtml(hireReportWorkbookQa.pipeline)
    const closeoutHtml = renderHireReportHtml(hireReportWorkbookQa.closeout)

    expect(pipelineHtml).toContain('Pipeline status report')
    expect(closeoutHtml).toContain('Job close-out report')
    expect(pipelineHtml).toContain('Evidence is displayed by source')
    expect(closeoutHtml).toContain('does not calculate a composite score')
    expect(pipelineHtml).not.toContain('candidateId')
    expect(closeoutHtml).not.toContain('111111111111111111111111')
    expect(closeoutHtml).not.toContain('resumeText')
  })

  it('uses the configured system Chromium and an injected renderer for worker tests', async () => {
    await expect(resolveHireReportChromiumLaunch({ CHROMIUM_PATH: '/usr/bin/chromium' })).resolves.toEqual({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const renderHtml = async (html: string, launch: { executablePath: string; args: string[] }) => {
      expect(html).toContain('Job close-out report')
      expect(launch.executablePath).toBe('/usr/bin/chromium')
      return Buffer.from('%PDF-report')
    }
    await expect(generateHireReportPdf(hireReportWorkbookQa.closeout, {
      resolveLaunch: async () => ({ executablePath: '/usr/bin/chromium', args: [] }),
      renderHtml,
    })).resolves.toEqual(Buffer.from('%PDF-report'))
  })

  it('uses non-PII report filenames', () => {
    expect(hireReportPdfFilename('pipeline_status')).toBe('pipeline-status-report.pdf')
    expect(hireReportPdfFilename('job_closeout')).toBe('job-closeout-report.pdf')
  })
})
