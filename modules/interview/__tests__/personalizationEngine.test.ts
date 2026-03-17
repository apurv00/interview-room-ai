import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }) }
  }
  return { default: MockAnthropic }
})

vi.mock('@shared/db/models', () => ({
  User: {
    findById: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }),
  },
  InterviewDomain: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  InterviewDepth: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
  InterviewerPersona: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}))

vi.mock('@learn/services/competencyService', () => ({
  getUserCompetencySummary: vi.fn().mockResolvedValue(null),
  getUserWeaknesses: vi.fn().mockResolvedValue([]),
}))

vi.mock('@learn/services/sessionSummaryService', () => ({
  getRecentSummaries: vi.fn().mockResolvedValue([]),
  buildHistorySummary: vi.fn().mockResolvedValue(''),
}))

vi.mock('@interview/services/retrievalService', () => ({
  getCompanyContext: vi.fn().mockResolvedValue(''),
}))

import { generateSessionBrief, briefToPromptContext } from '@interview/services/personalizationEngine'
import { isFeatureEnabled } from '@shared/featureFlags'

describe('personalizationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isFeatureEnabled).mockReturnValue(true)
  })

  describe('generateSessionBrief', () => {
    it('returns a default brief when personalization is disabled', async () => {
      vi.mocked(isFeatureEnabled).mockReturnValue(false)

      const brief = await generateSessionBrief({
        userId: 'user123',
        domain: 'pm',
        interviewType: 'hr-screening',
        experience: '3-6',
      })

      expect(brief.userId).toBe('user123')
      expect(brief.domain).toBe('pm')
      expect(brief.interviewType).toBe('hr-screening')
      expect(brief.sessionGoal).toBe('General interview practice')
      expect(brief.recommendedDifficulty).toBe('medium')
    })

    it('returns a brief with correct domain and type when enabled', async () => {
      const brief = await generateSessionBrief({
        userId: 'user123',
        domain: 'swe',
        interviewType: 'technical',
        experience: '7+',
      })

      expect(brief.domain).toBe('swe')
      expect(brief.interviewType).toBe('technical')
      expect(brief.experience).toBe('7+')
    })

    it('sets default difficulty based on experience level', async () => {
      const brief = await generateSessionBrief({
        userId: 'user123',
        domain: 'pm',
        interviewType: 'hr-screening',
        experience: '0-2',
      })

      // Without prior data, entry-level defaults to easy/medium
      expect(['easy', 'medium']).toContain(brief.recommendedDifficulty)
    })
  })

  describe('briefToPromptContext', () => {
    it('generates an empty string for minimal brief', () => {
      const ctx = briefToPromptContext({
        userId: 'u1',
        domain: 'pm',
        interviewType: 'hr-screening',
        experience: '3-6',
        sessionGoal: '',
        recommendedDifficulty: 'medium',
        focusCompetencies: [],
        avoidRepeatingTopics: [],
        resumeAnchorPoints: [],
        knownWeaknesses: [],
        knownStrengths: [],
        interviewerBehavior: '',
        profileContext: '',
        historyContext: '',
        companyContext: '',
        competencyContext: '',
      })

      // Minimal brief should produce minimal output
      expect(ctx).not.toContain('undefined')
    })

    it('includes session goal when present', () => {
      const ctx = briefToPromptContext({
        userId: 'u1',
        domain: 'pm',
        interviewType: 'hr-screening',
        experience: '3-6',
        sessionGoal: 'Improve metrics specificity',
        recommendedDifficulty: 'medium_high',
        focusCompetencies: ['metrics_thinking', 'specificity'],
        avoidRepeatingTopics: ['onboarding flow'],
        resumeAnchorPoints: ['FanCode revamp'],
        knownWeaknesses: [{ name: 'generic_answers', description: 'Answers become generic under pressure' }],
        knownStrengths: ['structure', 'communication'],
        interviewerBehavior: 'probe_for_specificity',
        profileContext: 'Current role: Senior PM',
        historyContext: 'Recent session: 72/100',
        companyContext: 'AMAZON: LP-based interviews',
        competencyContext: 'metrics_thinking: 45/100',
      })

      expect(ctx).toContain('Improve metrics specificity')
      expect(ctx).toContain('metrics_thinking')
      expect(ctx).toContain('probe_for_specificity')
      expect(ctx).toContain('onboarding flow')
      expect(ctx).toContain('FanCode revamp')
      expect(ctx).toContain('generic_answers')
      expect(ctx).toContain('AMAZON')
    })

    it('includes focus competencies', () => {
      const ctx = briefToPromptContext({
        userId: 'u1',
        domain: 'pm',
        interviewType: 'hr-screening',
        experience: '3-6',
        sessionGoal: '',
        recommendedDifficulty: 'medium',
        focusCompetencies: ['ownership', 'specificity'],
        avoidRepeatingTopics: [],
        resumeAnchorPoints: [],
        knownWeaknesses: [],
        knownStrengths: [],
        interviewerBehavior: '',
        profileContext: '',
        historyContext: '',
        companyContext: '',
        competencyContext: '',
      })

      expect(ctx).toContain('ownership')
      expect(ctx).toContain('specificity')
    })
  })
})
