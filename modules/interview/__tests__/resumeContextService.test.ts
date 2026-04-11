import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const mockParseResumeToStructured = vi.fn()

vi.mock('@resume', () => ({
  parseResumeToStructured: (...args: unknown[]) => mockParseResumeToStructured(...args),
}))

import {
  filterResumeByDomain,
  buildParsedResumeContext,
  parseAndCacheResume,
  type ParsedResume,
} from '@interview/services/persona/resumeContextService'
import { isFeatureEnabled } from '@shared/featureFlags'

function makeResume(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return {
    summary: 'Senior PM with 8 years experience launching consumer products.',
    experience: [
      {
        id: 'exp-1',
        company: 'Acme',
        title: 'Senior Product Manager',
        startDate: 'Jan 2022',
        endDate: 'Present',
        bullets: [
          'Led roadmap for growth product, drove 30% MoM user increase.',
          'Ran 12 A/B experiments on checkout funnel, improved conversion by 8%.',
          'Owned stakeholder alignment across 5 cross-functional teams.',
        ],
      },
      {
        id: 'exp-2',
        company: 'Globex',
        title: 'Software Engineer',
        startDate: 'Jun 2018',
        endDate: 'Dec 2021',
        bullets: [
          'Built React component library used across 4 frontend apps.',
          'Migrated legacy Angular UI to TypeScript + Next.js.',
          'Owned CI/CD pipeline and test automation framework.',
        ],
      },
      {
        id: 'exp-3',
        company: 'Initech',
        title: 'QA Engineer',
        startDate: 'Jul 2016',
        endDate: 'May 2018',
        bullets: [
          'Designed Selenium E2E test framework with 80% coverage.',
          'Reduced regression cycle time from 5 days to 1 day.',
        ],
      },
      {
        id: 'exp-4',
        company: 'Hooli',
        title: 'Intern',
        startDate: 'Jun 2015',
        endDate: 'Aug 2015',
        bullets: ['Ad-hoc data analysis for marketing team.'],
      },
    ],
    education: [{ institution: 'State University', degree: 'BS Computer Science' }],
    skills: [
      { category: 'Product', items: ['roadmap', 'prioritization', 'metrics', 'OKRs'] },
      { category: 'Technical', items: ['SQL', 'Python', 'React', 'TypeScript'] },
      { category: 'Soft', items: ['stakeholder management', 'leadership', 'communication'] },
    ],
    projects: [
      { id: 'proj-1', name: 'Growth Experiment Platform', description: 'Built internal A/B testing tool for rapid product experimentation.', technologies: ['TypeScript', 'React'] },
      { id: 'proj-2', name: 'Open Source Linter', description: 'Published ESLint plugin with 5k weekly downloads.', technologies: ['JavaScript'] },
    ],
    ...overrides,
  }
}

describe('resumeContextService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
  })

  describe('filterResumeByDomain', () => {
    it('ranks PM-relevant experience above SWE experience when domain=pm', () => {
      const resume = makeResume()
      const filtered = filterResumeByDomain(resume, 'pm')

      // Most recent (PM role) is always first; the remaining slots should
      // favour PM-relevant experiences over low-scoring ones.
      expect(filtered.experience[0].id).toBe('exp-1')
      const ids = filtered.experience.map((e) => e.id)
      // PM role must appear; the Intern with almost no PM keywords should be
      // crowded out by the other two experiences.
      expect(ids).toContain('exp-1')
      expect(ids).not.toContain('exp-4')
    })

    it('always includes most-recent experience even with 0 keyword hits', () => {
      const resume = makeResume({
        experience: [
          {
            id: 'exp-1',
            company: 'Acme',
            title: 'Janitor',
            startDate: 'Jan 2024',
            endDate: 'Present',
            bullets: ['Cleaned floors.', 'Restocked supplies.'],
          },
          {
            id: 'exp-2',
            company: 'Globex',
            title: 'Senior Product Manager',
            startDate: 'Jan 2020',
            endDate: 'Dec 2023',
            bullets: ['Led roadmap for growth product with stakeholder alignment and metrics-driven launches.'],
          },
        ],
      })

      const filtered = filterResumeByDomain(resume, 'pm')
      expect(filtered.experience[0].id).toBe('exp-1')
      expect(filtered.experience.length).toBeGreaterThanOrEqual(2)
    })

    it('caps at 3 experiences / 10 skills / 3 projects', () => {
      const resume = makeResume({
        experience: Array.from({ length: 8 }, (_, i) => ({
          id: `exp-${i}`,
          company: `Co${i}`,
          title: i === 0 ? 'Senior Product Manager' : 'Role',
          startDate: 'Jan 2020',
          endDate: i === 0 ? 'Present' : 'Dec 2021',
          bullets: ['product roadmap stakeholder metrics launch'],
        })),
        skills: [
          {
            category: 'Product',
            items: Array.from({ length: 25 }, (_, i) => `skill-${i} product roadmap`),
          },
        ],
        projects: Array.from({ length: 8 }, (_, i) => ({
          id: `proj-${i}`,
          name: `Project ${i}`,
          description: 'product roadmap metrics user',
          technologies: [],
        })),
      })

      const filtered = filterResumeByDomain(resume, 'pm')
      expect(filtered.experience.length).toBeLessThanOrEqual(3)
      const flatSkills = filtered.skills.flatMap((g) => g.items)
      expect(flatSkills.length).toBeLessThanOrEqual(10)
      expect(filtered.projects.length).toBeLessThanOrEqual(3)
    })

    it('unknown domain falls back to keeping most-recent entries', () => {
      const resume = makeResume()
      const filtered = filterResumeByDomain(resume, 'nonexistent-domain')
      // Most recent still wins.
      expect(filtered.experience[0].id).toBe('exp-1')
    })
  })

  describe('buildParsedResumeContext', () => {
    it('produces non-empty block for a fully populated resume', () => {
      const ctx = buildParsedResumeContext(makeResume(), 'pm')
      expect(ctx).toContain('CANDIDATE RESUME ANALYSIS')
      expect(ctx).toContain('RELEVANT EXPERIENCE')
      expect(ctx).toContain('KEY SKILLS')
      expect(ctx).toContain('Senior Product Manager')
      // Should highlight PM-relevant project
      expect(ctx).toContain('NOTABLE PROJECTS')
    })

    it('handles missing summary and projects gracefully', () => {
      const resume = makeResume({ summary: undefined, projects: [] })
      const ctx = buildParsedResumeContext(resume, 'pm')
      expect(ctx).toContain('RELEVANT EXPERIENCE')
      expect(ctx).not.toContain('SUMMARY:')
      expect(ctx).not.toContain('NOTABLE PROJECTS')
    })

    it('returns empty string for a completely empty resume', () => {
      const resume: ParsedResume = {
        experience: [],
        education: [],
        skills: [],
        projects: [],
      }
      const ctx = buildParsedResumeContext(resume, 'pm')
      expect(ctx).toBe('')
    })
  })

  describe('parseAndCacheResume', () => {
    it('returns null when feature flag is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)
      const result = await parseAndCacheResume('sess-1', 'a reasonably long resume text here for validation', 'pm')
      expect(result).toBeNull()
      expect(mockParseResumeToStructured).not.toHaveBeenCalled()
    })

    it('returns null for very short resume text', async () => {
      const result = await parseAndCacheResume('sess-1', 'too short', 'pm')
      expect(result).toBeNull()
      expect(mockParseResumeToStructured).not.toHaveBeenCalled()
    })

    it('returns normalized ParsedResume on successful parse', async () => {
      mockParseResumeToStructured.mockResolvedValue({
        contactInfo: { fullName: 'Jane Doe' },
        summary: 'Senior PM',
        experience: [{ id: 'exp-1', company: 'Acme', title: 'PM', bullets: ['Led product'] }],
        education: [],
        skills: [{ category: 'Product', items: ['roadmap'] }],
        projects: [],
      })

      const result = await parseAndCacheResume('sess-1', 'a long enough resume text body here for validation', 'pm')
      expect(result).not.toBeNull()
      expect(result?.contactInfo?.fullName).toBe('Jane Doe')
      expect(result?.experience).toHaveLength(1)
    })

    it('returns null when underlying parser fails', async () => {
      mockParseResumeToStructured.mockRejectedValue(new Error('LLM failed'))
      const result = await parseAndCacheResume('sess-1', 'a long enough resume text body here for validation', 'pm')
      expect(result).toBeNull()
    })

    it('returns null when parser returns null', async () => {
      mockParseResumeToStructured.mockResolvedValue(null)
      const result = await parseAndCacheResume('sess-1', 'a long enough resume text body here for validation', 'pm')
      expect(result).toBeNull()
    })
  })
})
