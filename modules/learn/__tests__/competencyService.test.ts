import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all dependencies
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockFindOne = vi.fn()
const mockFind = vi.fn()
const mockCreate = vi.fn()
const mockUpdateOne = vi.fn()
const mockSave = vi.fn()

vi.mock('@shared/db/models', () => ({
  UserCompetencyState: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => ({ sort: () => ({ limit: () => ({ lean: () => mockFind(...args) }) }) }),
    create: (...args: unknown[]) => mockCreate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  WeaknessCluster: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => ({ sort: () => ({ limit: () => ({ lean: () => mockFind(...args) }) }) }),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}))

import { getCompetenciesForDomain, DOMAIN_COMPETENCIES, UNIVERSAL_COMPETENCIES } from '@learn/services/competencyService'
import { isFeatureEnabled } from '@shared/featureFlags'

describe('competencyService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getCompetenciesForDomain', () => {
    it('returns universal + domain competencies for known domain', () => {
      const competencies = getCompetenciesForDomain('pm')
      expect(competencies).toContain('relevance')
      expect(competencies).toContain('structure')
      expect(competencies).toContain('product_sense')
      expect(competencies).toContain('metrics_thinking')
      expect(competencies.length).toBe(UNIVERSAL_COMPETENCIES.length + DOMAIN_COMPETENCIES['pm'].length)
    })

    it('returns only universal competencies for unknown domain', () => {
      const competencies = getCompetenciesForDomain('unknown_domain')
      expect(competencies.length).toBe(UNIVERSAL_COMPETENCIES.length)
    })

    it('handles SWE domain', () => {
      const competencies = getCompetenciesForDomain('swe')
      expect(competencies).toContain('technical_accuracy')
      expect(competencies).toContain('system_design')
      expect(competencies).toContain('problem_solving')
    })

    it('handles data-science domain', () => {
      const competencies = getCompetenciesForDomain('data-science')
      expect(competencies).toContain('statistical_knowledge')
      expect(competencies).toContain('ml_depth')
    })
  })

  describe('UNIVERSAL_COMPETENCIES', () => {
    it('contains core competencies', () => {
      expect(UNIVERSAL_COMPETENCIES).toContain('relevance')
      expect(UNIVERSAL_COMPETENCIES).toContain('structure')
      expect(UNIVERSAL_COMPETENCIES).toContain('specificity')
      expect(UNIVERSAL_COMPETENCIES).toContain('ownership')
      expect(UNIVERSAL_COMPETENCIES).toContain('communication')
    })
  })

  describe('DOMAIN_COMPETENCIES', () => {
    it('has entries for all major domains', () => {
      const expectedDomains = ['pm', 'swe', 'data-science', 'design', 'sales', 'mba', 'consulting', 'finance', 'marketing', 'devops', 'hr', 'legal']
      for (const domain of expectedDomains) {
        expect(DOMAIN_COMPETENCIES).toHaveProperty(domain)
        expect(DOMAIN_COMPETENCIES[domain].length).toBeGreaterThan(0)
      }
    })
  })

  describe('feature flag gating', () => {
    it('getUserCompetencySummary returns null when flag disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const { getUserCompetencySummary } = await import('@learn/services/competencyService')
      const result = await getUserCompetencySummary('user123')
      expect(result).toBeNull()
    })

    it('getUserWeaknesses returns empty when flag disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const { getUserWeaknesses } = await import('@learn/services/competencyService')
      const result = await getUserWeaknesses('user123')
      expect(result).toEqual([])
    })
  })
})
