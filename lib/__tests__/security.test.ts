import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  AnswerEvaluationSchema,
  SpeechMetricsSchema,
  GenerateFeedbackSchema,
  UpdateSessionSchema,
  EvaluateAnswerSchema,
} from '@/lib/validators/interview'
import {
  CreateDomainSchema,
  UpdateDomainSchema,
  CreateInterviewTypeSchema,
  UpdateInterviewTypeSchema,
} from '@/lib/validators/cms'
import { canViewSession, hasRole, canAccessOrg } from '@/lib/auth/permissions'

// ─── Authorization Boundary Tests ───────────────────────────────────────────

describe('canViewSession — authorization boundaries', () => {
  it('allows session owner to view their own session', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: undefined },
      { id: 'user-1', role: 'candidate', organizationId: undefined }
    )).toBe(true)
  })

  it('blocks non-owner candidate from viewing another user session', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: undefined },
      { id: 'user-2', role: 'candidate', organizationId: undefined }
    )).toBe(false)
  })

  it('blocks recruiter from different org', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: 'org-A' },
      { id: 'user-2', role: 'recruiter', organizationId: 'org-B' }
    )).toBe(false)
  })

  it('allows recruiter from same org', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: 'org-A' },
      { id: 'user-2', role: 'recruiter', organizationId: 'org-A' }
    )).toBe(true)
  })

  it('allows platform_admin to view any session', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: 'org-A' },
      { id: 'admin-1', role: 'platform_admin', organizationId: undefined }
    )).toBe(true)
  })

  it('blocks candidate from accessing session without org even with matching org', () => {
    expect(canViewSession(
      { userId: 'user-1', organizationId: undefined },
      { id: 'user-2', role: 'recruiter', organizationId: 'org-A' }
    )).toBe(false)
  })
})

describe('hasRole — role hierarchy', () => {
  it('candidate cannot access recruiter features', () => {
    expect(hasRole('candidate', 'recruiter')).toBe(false)
  })

  it('recruiter can access candidate features', () => {
    expect(hasRole('recruiter', 'candidate')).toBe(true)
  })

  it('platform_admin can access everything', () => {
    expect(hasRole('platform_admin', 'candidate')).toBe(true)
    expect(hasRole('platform_admin', 'recruiter')).toBe(true)
    expect(hasRole('platform_admin', 'org_admin')).toBe(true)
    expect(hasRole('platform_admin', 'platform_admin')).toBe(true)
  })

  it('unknown role defaults to lowest level', () => {
    expect(hasRole('unknown_role', 'candidate')).toBe(true) // level 0 >= level 0
    expect(hasRole('unknown_role', 'recruiter')).toBe(false)
  })
})

describe('canAccessOrg — tenant isolation', () => {
  it('platform_admin can access any org', () => {
    expect(canAccessOrg(undefined, 'org-A', 'platform_admin')).toBe(true)
  })

  it('user can access own org', () => {
    expect(canAccessOrg('org-A', 'org-A', 'recruiter')).toBe(true)
  })

  it('user cannot access different org', () => {
    expect(canAccessOrg('org-A', 'org-B', 'recruiter')).toBe(false)
  })

  it('user without org cannot access any org', () => {
    expect(canAccessOrg(undefined, 'org-A', 'recruiter')).toBe(false)
  })
})

// ─── Input Validation Tests ─────────────────────────────────────────────────

describe('AnswerEvaluationSchema — rejects invalid/malicious input', () => {
  const validEval = {
    questionIndex: 0,
    question: 'Tell me about yourself',
    answer: 'I am a software engineer...',
    relevance: 80,
    structure: 75,
    specificity: 70,
    ownership: 85,
    needsFollowUp: false,
    flags: [],
  }

  it('accepts valid evaluation data', () => {
    expect(AnswerEvaluationSchema.safeParse(validEval).success).toBe(true)
  })

  it('rejects scores above 100', () => {
    expect(AnswerEvaluationSchema.safeParse({ ...validEval, relevance: 150 }).success).toBe(false)
  })

  it('rejects negative scores', () => {
    expect(AnswerEvaluationSchema.safeParse({ ...validEval, structure: -10 }).success).toBe(false)
  })

  it('rejects non-numeric scores', () => {
    expect(AnswerEvaluationSchema.safeParse({ ...validEval, ownership: 'high' }).success).toBe(false)
  })

  it('rejects excessive flags array', () => {
    const tooManyFlags = Array(11).fill('flag')
    expect(AnswerEvaluationSchema.safeParse({ ...validEval, flags: tooManyFlags }).success).toBe(false)
  })
})

describe('SpeechMetricsSchema — rejects invalid data', () => {
  const validMetrics = {
    wpm: 140,
    fillerRate: 0.05,
    pauseScore: 70,
    ramblingIndex: 0.2,
    totalWords: 250,
    fillerWordCount: 12,
    durationMinutes: 1.8,
  }

  it('accepts valid speech metrics', () => {
    expect(SpeechMetricsSchema.safeParse(validMetrics).success).toBe(true)
  })

  it('rejects WPM above 500', () => {
    expect(SpeechMetricsSchema.safeParse({ ...validMetrics, wpm: 600 }).success).toBe(false)
  })

  it('rejects filler rate above 1', () => {
    expect(SpeechMetricsSchema.safeParse({ ...validMetrics, fillerRate: 1.5 }).success).toBe(false)
  })
})

// ─── CMS Validation Tests ───────────────────────────────────────────────────

describe('CreateDomainSchema — CMS input validation', () => {
  it('accepts valid domain data', () => {
    const result = CreateDomainSchema.safeParse({
      slug: 'software-engineering',
      label: 'Software Engineering',
      description: 'Software engineering interview domain',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid slug format (uppercase)', () => {
    const result = CreateDomainSchema.safeParse({
      slug: 'Software_Engineering',
      label: 'SE',
    })
    expect(result.success).toBe(false)
  })

  it('rejects slug with special characters', () => {
    const result = CreateDomainSchema.safeParse({
      slug: 'se<script>alert(1)</script>',
      label: 'SE',
    })
    expect(result.success).toBe(false)
  })

  it('rejects excessively long systemPromptContext', () => {
    const result = CreateDomainSchema.safeParse({
      slug: 'test',
      label: 'Test',
      systemPromptContext: 'x'.repeat(5001),
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty slug', () => {
    const result = CreateDomainSchema.safeParse({
      slug: '',
      label: 'Test',
    })
    expect(result.success).toBe(false)
  })
})

describe('CreateInterviewTypeSchema — CMS input validation', () => {
  it('accepts valid interview type data', () => {
    const result = CreateInterviewTypeSchema.safeParse({
      slug: 'technical-deep-dive',
      label: 'Technical Deep Dive',
      scoringDimensions: [
        { name: 'depth', label: 'Technical Depth', weight: 0.4 },
        { name: 'accuracy', label: 'Accuracy', weight: 0.6 },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects scoring dimension weights above 1', () => {
    const result = CreateInterviewTypeSchema.safeParse({
      slug: 'test',
      label: 'Test',
      scoringDimensions: [
        { name: 'depth', label: 'Depth', weight: 1.5 },
      ],
    })
    expect(result.success).toBe(false)
  })
})

// ─── R2 Key Ownership Validation Tests ──────────────────────────────────────

describe('R2 key ownership validation logic', () => {
  function validateR2KeyOwnership(key: string, userId: string): boolean {
    const keySegments = key.split('/')
    if (
      keySegments.length < 3 ||
      !['recordings', 'documents'].includes(keySegments[0]) ||
      keySegments[1] !== userId
    ) {
      return false
    }
    return true
  }

  it('allows user to access their own recording', () => {
    expect(validateR2KeyOwnership('recordings/user-123/session-abc-1234.webm', 'user-123')).toBe(true)
  })

  it('blocks access to another user recording', () => {
    expect(validateR2KeyOwnership('recordings/user-456/session-abc-1234.webm', 'user-123')).toBe(false)
  })

  it('allows user to access their own document', () => {
    expect(validateR2KeyOwnership('documents/user-123/jd/resume.pdf', 'user-123')).toBe(true)
  })

  it('blocks access to another user document', () => {
    expect(validateR2KeyOwnership('documents/user-456/jd/resume.pdf', 'user-123')).toBe(false)
  })

  it('blocks access with path traversal attempt', () => {
    expect(validateR2KeyOwnership('recordings/../admin/secrets', 'user-123')).toBe(false)
  })

  it('blocks access with unknown prefix', () => {
    expect(validateR2KeyOwnership('admin/user-123/config.json', 'user-123')).toBe(false)
  })

  it('blocks access with too few segments', () => {
    expect(validateR2KeyOwnership('recordings', 'user-123')).toBe(false)
  })
})

// ─── Free Plan Limit Tests ──────────────────────────────────────────────────

describe('Plan limits configuration', () => {
  it('free plan has a limited interview count', async () => {
    const { PLANS } = await import('@/lib/services/stripe')
    expect(PLANS.free.monthlyInterviewLimit).toBeLessThanOrEqual(10)
    expect(PLANS.free.monthlyInterviewLimit).toBeGreaterThan(0)
  })

  it('pro plan has higher limits than free', async () => {
    const { PLANS } = await import('@/lib/services/stripe')
    expect(PLANS.pro.monthlyInterviewLimit).toBeGreaterThan(PLANS.free.monthlyInterviewLimit)
  })
})
