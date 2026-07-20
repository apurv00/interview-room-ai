import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { mockCompletion, mockGetActiveCatalog } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockGetActiveCatalog: vi.fn(),
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: (...args: unknown[]) => mockCompletion(...args),
}))
vi.mock('@interview/services/persona/domainCatalogService', () => ({
  getActiveInterviewDomainCatalog: mockGetActiveCatalog,
}))

import { parseJobDescription, buildParsedJDContext } from '@interview/services/persona/jdParserService'
import { isFeatureEnabled } from '@shared/featureFlags'
import type { IParsedJobDescription } from '@shared/types'

const ACTIVE_CATALOG = {
  slugs: ['backend', 'custom-quant-role', 'general', 'mobile', 'pm'],
  slugSet: new Set(['backend', 'custom-quant-role', 'general', 'mobile', 'pm']),
  inferenceSlugSet: new Set(['backend', 'custom-quant-role', 'general', 'mobile', 'pm']),
  revision: 'jd-role-v2:test',
  authoritative: true,
  source: 'cms' as const,
}

describe('jdParserService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
    mockGetActiveCatalog.mockResolvedValue(ACTIVE_CATALOG)
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

    it('offers the active CMS taxonomy to the model', async () => {
      await parseJobDescription('Mobile engineer role with Android ownership and release experience.')

      const request = mockCompletion.mock.calls[0][0] as { system: string }
      expect(request.system).toContain(
        `exactly one of: ${ACTIVE_CATALOG.slugs.join(', ')}`,
      )
    })

    it('accepts active built-in/custom slugs and rejects inactive or arbitrary output', async () => {
      const response = (inferredDomain: unknown) => ({
        text: JSON.stringify({
          company: 'Acme Corp',
          role: 'Mobile Engineer',
          inferredDomain,
          requirements: [{
            id: 'req_1',
            category: 'technical',
            requirement: 'Android experience',
            importance: 'must-have',
            targetCompetencies: [],
          }],
          keyThemes: ['mobile'],
        }),
      })
      mockCompletion
        .mockResolvedValueOnce(response(' Mobile '))
        .mockResolvedValueOnce(response('custom-quant-role'))
        .mockResolvedValueOnce(response('frontend'))
        .mockResolvedValueOnce(response('attacker-controlled-role'))

      expect((await parseJobDescription('A valid mobile role')).inferredDomain).toBe('mobile')
      expect((await parseJobDescription('A CMS-added quant role')).inferredDomain).toBe('custom-quant-role')
      expect((await parseJobDescription('An inactive built-in role')).inferredDomain).toBe('')
      expect((await parseJobDescription('An untrusted role')).inferredDomain).toBe('')
    })

    it('rejects an active slug that was not advertised in the bounded inference enum', async () => {
      const boundedCatalog = {
        ...ACTIVE_CATALOG,
        slugs: ['backend'],
        inferenceSlugSet: new Set(['backend']),
      }
      mockGetActiveCatalog.mockResolvedValue(boundedCatalog)
      mockCompletion.mockResolvedValue({
        text: JSON.stringify({
          company: 'Acme Corp',
          role: 'Quant Engineer',
          inferredDomain: 'custom-quant-role',
          requirements: [{
            id: 'req_1',
            category: 'technical',
            requirement: 'Pricing systems',
            importance: 'must-have',
            targetCompetencies: [],
          }],
          keyThemes: ['pricing'],
        }),
      })

      const result = await parseJobDescription('Quant engineer role')

      expect(boundedCatalog.slugSet.has('custom-quant-role')).toBe(true)
      expect(result.inferredDomain).toBe('')
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
