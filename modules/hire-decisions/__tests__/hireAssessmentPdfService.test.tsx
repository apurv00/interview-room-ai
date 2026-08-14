import { describe, expect, it } from 'vitest'
import {
  generateHireAssessmentPdf,
  hireAssessmentPdfFilename,
  renderHireAssessmentHtml,
  resolveHireAssessmentChromiumLaunch,
} from '../services/hireAssessmentPdfService'
import type { HireDecisionView } from '../types'

const decision: HireDecisionView = {
  coordinates: {
    workspaceId: '111111111111111111111111',
    applicationId: '222222222222222222222222',
    jobId: '333333333333333333333333',
    candidateId: '444444444444444444444444',
  },
  candidateBrief: {
    candidateName: '<Ada & Co>',
    jobTitle: 'Platform Engineer',
    location: 'London',
    experienceYears: 6,
  },
  aiAssessments: [{
    completedAt: new Date('2026-08-14T00:00:00.000Z'),
    overallScore: 82,
    recommendation: 'advance',
    confidence: 'high',
    dimensions: [{ key: 'communication', label: 'Communication', score: 85 }],
  }],
  humanScorecards: {
    total: { count: 1, recommendations: { strong_yes: 0, yes: 1, no: 0, strong_no: 0 }, dimensions: [] },
    member: { count: 1, recommendations: { strong_yes: 0, yes: 1, no: 0, strong_no: 0 }, dimensions: [] },
    kit: { count: 0, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 }, dimensions: [] },
  },
  externalVerdicts: { count: 1, recommendations: { strong_yes: 1, yes: 0, no: 0, strong_no: 0 } },
}

describe('Hire assessment PDF rendering', () => {
  it('renders the safe decision DTO and React-escapes prose', () => {
    const html = renderHireAssessmentHtml(decision)
    expect(html).toContain('&lt;Ada &amp; Co&gt;')
    expect(html).toContain('External verdicts')
    expect(html).not.toContain('resumeText')
    expect(html).not.toContain('closeNote')
    expect(html).not.toContain('rawEngineOutput')
  })

  it('uses the configured system chromium and accepts an injected PDF renderer', async () => {
    await expect(resolveHireAssessmentChromiumLaunch({ CHROMIUM_PATH: '/usr/bin/chromium' })).resolves.toEqual({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const renderHtml = async (html: string, launch: { executablePath: string; args: string[] }) => {
      expect(html).toContain('Candidate assessment')
      expect(launch.executablePath).toBe('/usr/bin/chromium')
      return Buffer.from('%PDF-test')
    }
    await expect(generateHireAssessmentPdf(decision, {
      resolveLaunch: async () => ({ executablePath: '/usr/bin/chromium', args: [] }),
      renderHtml,
    })).resolves.toEqual(Buffer.from('%PDF-test'))
  })

  it('uses a non-PII attachment filename', () => {
    expect(hireAssessmentPdfFilename()).toBe('candidate-assessment.pdf')
  })
})
