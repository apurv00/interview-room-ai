import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockCompletion = vi.fn()

vi.mock('@shared/services/modelRouter', () => ({
  completion: (...args: unknown[]) => mockCompletion(...args),
}))

import { parseJobDescription, buildParsedJDContext } from '@interview/services/persona/jdParserService'
import { isFeatureEnabled } from '@shared/featureFlags'
import type { IParsedJobDescription } from '@shared/db/models/SavedJobDescription'

describe('jdParserService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
    mockCompletion.mockResolvedValue({
      text: JSON.stringify({
        company: 'Acme Corp',
        role: 'Senior Product Manager',
        inferredDomain: 'pm',
        requirements: [
          { id: 'req_1', category: 'experience', requirement: '5+ years product management experience', importance: 'must-have', targetCompetencies: ['product_sense', 'execution'] },
          { id: 'req_2', category: 'behavioral', requirement: 'Cross-functional leadership', importance: 'must-have', targetCompetencies: ['stakeholder_management'] },
          { id: 'req_3', category: 'technical', requirement: 'SQL and data analysis', importance: 'nice-to-have', targetCompetencies: ['metrics_thinking'] },
        ],
        keyThemes: ['leadership', 'data-driven', 'user-centric'],
      }),
      model: 'claude-sonnet-4-6-20250514',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 200,
      usedFallback: false,
    })
  })

  describe('parseJobDescription', () => {
    it('parses a job description and returns structured data', async () => {
      const result = await parseJobDescription('We are looking for a Senior PM at Acme Corp...')

      expect(result.company).toBe('Acme Corp')
      expect(result.role).toBe('Senior Product Manager')
      expect(result.inferredDomain).toBe('pm')
      expect(result.requirements).toHaveLength(3)
      expect(result.requirements[0].importance).toBe('must-have')
      expect(result.requirements[2].importance).toBe('nice-to-have')
      expect(result.keyThemes).toContain('leadership')
    })

    it('returns fallback when feature flag is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)

      const result = await parseJobDescription('Some JD text')
      expect(result.rawText).toBe('Some JD text')
      expect(result.requirements).toHaveLength(0)
      expect(result.company).toBe('')
    })
  })

  describe('buildParsedJDContext', () => {
    it('builds prompt context from parsed JD', () => {
      const parsedJD: IParsedJobDescription = {
        rawText: 'raw text',
        company: 'Acme Corp',
        role: 'PM',
        inferredDomain: 'pm',
        requirements: [
          { id: 'r1', category: 'experience', requirement: '5+ years PM', importance: 'must-have', targetCompetencies: ['product_sense'] },
          { id: 'r2', category: 'technical', requirement: 'SQL', importance: 'nice-to-have', targetCompetencies: ['metrics_thinking'] },
        ],
        keyThemes: ['leadership', 'data-driven'],
      }

      const context = buildParsedJDContext(parsedJD)

      expect(context).toContain('JOB DESCRIPTION ANALYSIS')
      expect(context).toContain('PM at Acme Corp')
      expect(context).toContain('MUST-HAVE')
      expect(context).toContain('5+ years PM')
      expect(context).toContain('NICE-TO-HAVE')
      expect(context).toContain('SQL')
      expect(context).toContain('leadership, data-driven')
    })

    it('returns empty string for JD with no requirements', () => {
      const parsedJD: IParsedJobDescription = {
        rawText: 'raw', company: '', role: '', inferredDomain: '',
        requirements: [], keyThemes: [],
      }

      expect(buildParsedJDContext(parsedJD)).toBe('')
    })
  })
})
