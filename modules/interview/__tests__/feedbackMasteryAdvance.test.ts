/**
 * PR4 — verifies that generate-feedback fires masteryTracking and
 * universalPlanAdvance side-effects after scoring, and that
 * registerPathwayBadgeWiring is called at module init.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockCompletion, mockUpdateMasteryBatch, mockAdvanceUniversalPlan,
  mockRegisterBadgeWiring, mockInfo, mockWarn,
} = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockUpdateMasteryBatch: vi.fn().mockResolvedValue([]),
  mockAdvanceUniversalPlan: vi.fn().mockResolvedValue(null),
  mockRegisterBadgeWiring: vi.fn(),
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
}))

vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => async (req: NextRequest) => {
    const raw = await req.json()
    const body = opts.schema ? opts.schema.parse(raw) : raw
    return opts.handler(req, {
      user: { id: '507f1f77bcf86cd799439099', role: 'candidate', plan: 'free', email: 't@example.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mockWarn, error: vi.fn(), info: mockInfo, debug: vi.fn() },
  logger: { warn: mockWarn, error: vi.fn(), info: mockInfo, debug: vi.fn() },
}))

vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))

vi.mock('@shared/services/feedbackLock', () => ({
  acquireFeedbackLock: vi.fn().mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true }),
  releaseFeedbackLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/usageTracking', () => ({ trackUsage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/services/scoreTelemetry', () => ({ recordScoreDelta: vi.fn().mockResolvedValue(null) }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewSession: {
    findByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  },
}))
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))
vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 99,
  getQuestionCount: () => 5,
}))
vi.mock('@interview/config/speechMetrics', () => ({
  aggregateMetrics: () => ({ wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2 }),
  communicationScore: () => 72,
}))
vi.mock('@interview/services/core/skillLoader', () => ({ getSkillSections: vi.fn().mockResolvedValue(null) }))
vi.mock('@interview/config/companyProfiles', () => ({ findCompanyProfile: () => null }))
vi.mock('@interview/services/eval/evaluationEngine', () => ({ evaluateSession: vi.fn().mockResolvedValue({}) }))
vi.mock('@learn/services/competencyService', () => ({
  updateCompetencyState: vi.fn().mockResolvedValue(undefined),
  updateWeaknessClusters: vi.fn().mockResolvedValue(undefined),
  getUserCompetencySummary: vi.fn().mockResolvedValue(null),
}))
vi.mock('@learn/services/sessionSummaryService', () => ({
  generateSessionSummary: vi.fn().mockResolvedValue(undefined),
  buildHistorySummary: vi.fn().mockResolvedValue(null),
}))
vi.mock('@learn/services/pathwayPlanner', () => ({
  generatePathwayPlan: vi.fn().mockResolvedValue(undefined),
  advanceUniversalPlan: (...a: unknown[]) => mockAdvanceUniversalPlan(...a),
}))
vi.mock('@learn/services/practiceStatsService', () => ({
  updatePracticeStats: vi.fn().mockResolvedValue(undefined),
  deriveStrongWeakDimensions: () => ({ strongDimensions: ['relevance'], weakDimensions: ['ownership'] }),
}))
vi.mock('@learn/services/masteryTracker', () => ({
  updateMasteryBatch: (...a: unknown[]) => mockUpdateMasteryBatch(...a),
}))
vi.mock('@learn/services/pathwayBadgeWiring', () => ({
  registerPathwayBadgeWiring: (...a: unknown[]) => mockRegisterBadgeWiring(...a),
}))

import { POST } from '@/app/api/generate-feedback/route'

function evals(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    questionIndex: i,
    question: `Q${i + 1}?`,
    answer: 'A substantive answer with detail.',
    relevance: 80,
    structure: 75,
    specificity: 70,
    ownership: 65,
    probeDecision: { shouldProbe: false },
    flags: [],
  }))
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      role: 'pm',
      experience: '0-2',
      duration: 30,
      interviewType: 'screening',
    },
    transcript: [],
    evaluations: overrides.evaluations ?? evals(5),
    speechMetrics: [],
    answeredCount: 5,
    plannedQuestionCount: 5,
    sessionId: '507f1f77bcf86cd799439011',
    ...overrides,
  }
}

function happyCompletion() {
  return {
    // Previously this fixture emitted `answer_quality`/`communication_skills`/
    // `confidence_level` at the top level with no `dimensions` wrapper,
    // which accidentally tripped the inner fallback at route.ts:685
    // (`!feedback.dimensions`). That was tolerable when the inner fallback
    // fired silently, but once PR #317 made the inner fallback mark
    // `degraded: true` and skip non-idempotent side effects, this fixture
    // stopped actually testing the happy path — it was testing that
    // `masteryTracking` + `advanceUniversalPlan` fire on a DEGRADED
    // response (which they no longer do, intentionally).
    //
    // Corrected shape: wrap dimensions properly so the route takes the
    // fully-healthy path and side-effects fire because the response is
    // legitimate, not because the gate failed to trigger.
    text: JSON.stringify({
      overall_score: 72,
      pass_probability: 'Medium',
      confidence_level: 'High',
      dimensions: {
        answer_quality: {
          score: 71,
          strengths: ['Good structure'],
          weaknesses: ['Could be more specific'],
        },
        communication: { score: 70, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: { score: 72, engagement_score: 70, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 70 },
      },
      red_flags: [],
      top_3_improvements: ['Be more specific', 'Add metrics', 'Use STAR'],
      detailed_feedback: 'Good job.',
    }),
    inputTokens: 500,
    outputTokens: 200,
    model: 'interview.generate-feedback',
  }
}

describe('generate-feedback → badge wiring init', () => {
  it('registerPathwayBadgeWiring is called at module load', () => {
    expect(mockRegisterBadgeWiring).toHaveBeenCalled()
  })
})

describe('generate-feedback → mastery + universal plan wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCompletion.mockResolvedValue(happyCompletion())
  })

  it('fires updateMasteryBatch with per-dimension averages from evaluations', async () => {
    const res = await POST(new NextRequest('http://localhost/api/generate-feedback', {
      method: 'POST',
      body: JSON.stringify(makeBody()),
    }))
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))

    expect(mockUpdateMasteryBatch).toHaveBeenCalledOnce()
    const [userId, dimScores, domain] = mockUpdateMasteryBatch.mock.calls[0]
    expect(userId).toBe('507f1f77bcf86cd799439099')
    expect(domain).toBe('pm')
    expect(dimScores).toEqual({
      relevance: 80,
      structure: 75,
      specificity: 70,
      ownership: 65,
    })
  })

  it('fires advanceUniversalPlan with user ID', async () => {
    const res = await POST(new NextRequest('http://localhost/api/generate-feedback', {
      method: 'POST',
      body: JSON.stringify(makeBody()),
    }))
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))

    expect(mockAdvanceUniversalPlan).toHaveBeenCalledOnce()
    expect(mockAdvanceUniversalPlan).toHaveBeenCalledWith('507f1f77bcf86cd799439099')
  })

  it('does not fire mastery tracking when all evaluations are failed', async () => {
    const failedEvals = evals(3).map((e) => ({ ...e, status: 'failed' }))
    const res = await POST(new NextRequest('http://localhost/api/generate-feedback', {
      method: 'POST',
      body: JSON.stringify(makeBody({ evaluations: failedEvals })),
    }))
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))

    expect(mockUpdateMasteryBatch).not.toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).toHaveBeenCalledOnce()
  })

  it('skips both when no sessionId is present', async () => {
    const res = await POST(new NextRequest('http://localhost/api/generate-feedback', {
      method: 'POST',
      body: JSON.stringify(makeBody({ sessionId: undefined })),
    }))
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))

    expect(mockUpdateMasteryBatch).not.toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).not.toHaveBeenCalled()
  })

  it('mastery failure does not block the response or other side-effects', async () => {
    mockUpdateMasteryBatch.mockRejectedValueOnce(new Error('mastery db down'))

    const res = await POST(new NextRequest('http://localhost/api/generate-feedback', {
      method: 'POST',
      body: JSON.stringify(makeBody()),
    }))
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))

    expect(mockAdvanceUniversalPlan).toHaveBeenCalledOnce()

    // PR #322: aggregate log escalates to .warn when failedCount > 0.
    // Look in the warn sink (mastery rejection means failedCount=1).
    const summaryCall = mockWarn.mock.calls.find((c: unknown[]) =>
      typeof c[1] === 'string' && c[1].includes('post-feedback side effects settled'),
    )
    expect(summaryCall).toBeTruthy()
    const [context] = summaryCall as [Record<string, unknown>, string]
    expect(context.failedCount).toBe(1)
    const failed = context.failed as Array<{ name: string }>
    expect(failed.some((f) => f.name === 'masteryTracking')).toBe(true)
  })
})
