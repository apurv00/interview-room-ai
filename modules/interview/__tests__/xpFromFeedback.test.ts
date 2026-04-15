/**
 * Work Item G.14 — XP / practiceStats flag gate.
 *
 * Validates that:
 *   1. POST /api/learn/stats:
 *        - flag OFF → delegates to updatePracticeStats as today
 *        - flag ON  → returns `{success: true, skipped: 'xp_from_feedback'}`
 *                     without touching Mongo
 *   2. POST /api/generate-feedback:
 *        - flag OFF → does NOT call updatePracticeStats server-side
 *        - flag ON  → calls updatePracticeStats once with
 *                     feedback.overall_score and derived strong/weak
 *                     dimensions
 *
 * The two routes together replace the client-side fire-and-forget
 * XP call at useInterview.ts:862 with a server-side authoritative
 * write when the flag is flipped — users' XP finally matches the
 * number shown on their feedback page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockCompletion, mockIsFeatureEnabled, mockUpdatePracticeStats, mockGetServerSession,
} = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
  mockUpdatePracticeStats: vi.fn(),
  mockGetServerSession: vi.fn(),
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
      user: { id: '507f1f77bcf86cd799439099', role: 'candidate', plan: 'free', email: 't@e.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))

vi.mock('@shared/services/feedbackLock', () => ({
  acquireFeedbackLock: vi.fn().mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true }),
  releaseFeedbackLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/scoreTelemetry', () => ({
  recordScoreDelta: vi.fn().mockResolvedValue(null),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@shared/db/models', () => ({
  User: {
    findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'u1', practiceStats: {} }) }) }),
  },
  InterviewSession: { findByIdAndUpdate: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => mockIsFeatureEnabled(flag),
}))

vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'PM',
  getPressureQuestionIndex: () => 99,
  getQuestionCount: () => 16,
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
}))

// Mock the practiceStatsService where it's imported by BOTH consumers.
vi.mock('@learn/services/practiceStatsService', () => ({
  updatePracticeStats: (...args: unknown[]) => mockUpdatePracticeStats(...args),
  deriveStrongWeakDimensions: () => ({
    strongDimensions: ['ownership', 'relevance'],
    weakDimensions: ['structure', 'specificity'],
  }),
}))
// And via the barrel for the /api/learn/stats route.
vi.mock('@learn', () => ({
  updatePracticeStats: (...args: unknown[]) => mockUpdatePracticeStats(...args),
  deriveStrongWeakDimensions: () => ({
    strongDimensions: ['ownership', 'relevance'],
    weakDimensions: ['structure', 'specificity'],
  }),
}))

// Imports AFTER all vi.mock calls.
import { POST as LEARN_STATS_POST } from '@/app/api/learn/stats/route'
import { POST as GENERATE_FEEDBACK_POST } from '@/app/api/generate-feedback/route'

// ─── /api/learn/stats flag gate ───────────────────────────────────────────

describe('POST /api/learn/stats — G.14 flag gate', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset()
    mockUpdatePracticeStats.mockReset()
    mockUpdatePracticeStats.mockResolvedValue({ updated: true, key: 'pm:screening', totalSessions: 1, avgScore: 70 })
    mockGetServerSession.mockReset()
    mockGetServerSession.mockResolvedValue({ user: { id: '507f1f77bcf86cd799439099' } })
  })

  function makeReq(score = 70) {
    return new Request('http://localhost/api/learn/stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'pm', interviewType: 'screening', score,
      }),
    })
  }

  // G.15b-5 inverted: pre-G.15 the route had a flag-gate that
  // short-circuited when xp_from_feedback was ON. Post-G.15 the
  // route is a permanent no-op (regardless of flag state) — XP
  // is owned by /api/generate-feedback. These tests confirm the
  // permanent no-op shape.
  it('returns success+skipped marker without invoking updatePracticeStats', async () => {
    mockIsFeatureEnabled.mockImplementation(() => false)

    const res = await LEARN_STATS_POST(makeReq(70))
    const json = await res.json()

    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
    expect(json.success).toBe(true)
    expect(json.skipped).toBe('g15-noop')
  })

  it('returns same no-op shape regardless of isFeatureEnabled state', async () => {
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'xp_from_feedback')

    const res = await LEARN_STATS_POST(makeReq(70))
    const json = await res.json()

    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
    expect(json.skipped).toBe('g15-noop')
  })

  it('unauthorized session → 401, no write (auth before no-op)', async () => {
    mockGetServerSession.mockResolvedValue(null)

    const res = await LEARN_STATS_POST(makeReq(70))
    expect(res.status).toBe(401)
    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
  })
})

// ─── /api/generate-feedback server-side XP write ──────────────────────────

describe('POST /api/generate-feedback — G.14 server-side XP write', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset()
    mockUpdatePracticeStats.mockReset()
    mockUpdatePracticeStats.mockResolvedValue({ updated: true, key: 'pm:screening' })
    mockCompletion.mockReset()
  })

  function evals(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      questionIndex: i, question: `Q${i + 1}?`, answer: 'A',
      relevance: 70, structure: 65, specificity: 60, ownership: 75,
      probeDecision: { shouldProbe: false },
    }))
  }

  function makeReq(evaluations: unknown[]) {
    return new NextRequest('http://localhost:3000/api/generate-feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
        transcript: [], evaluations, speechMetrics: [],
        sessionId: '507f1f77bcf86cd799439011',
        // Post-G.15 G.10 multiplier is unconditional; default
        // plannedQuestionCount derives from getQuestionCount(30)=16
        // which would penalize a 5-eval test as 5/16=31% completion.
        // Set both fields equal to evaluations.length to neutralize
        // G.10 for these XP-focused tests.
        answeredCount: evaluations.length,
        plannedQuestionCount: evaluations.length,
      }),
    })
  }

  const happyFeedback = {
    text: JSON.stringify({
      overall_score: 72, pass_probability: 'Medium', confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 70, strengths: [], weaknesses: [] },
        communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
      },
      red_flags: [], top_3_improvements: ['A', 'B', 'C'],
    }),
    model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
  }

  // G.15b-5 inverted: pre-G.15 the route flag-gated the XP write
  // on `xp_from_feedback`. Post-G.15 the write is unconditional.
  it('always calls updatePracticeStats once with the final blended overall_score', async () => {
    mockIsFeatureEnabled.mockImplementation(() => false) // flag state irrelevant now
    mockCompletion.mockResolvedValueOnce(happyFeedback)

    await GENERATE_FEEDBACK_POST(makeReq(evals(5)))
    await new Promise((r) => setImmediate(r))

    expect(mockUpdatePracticeStats).toHaveBeenCalledTimes(1)
    const call = mockUpdatePracticeStats.mock.calls[0][0] as Record<string, unknown>
    expect(call.domain).toBe('pm')
    expect(call.interviewType).toBe('screening')
    // 5 evals each with dims 70/65/60/75 → per-row avg = 67.5,
    // Math.round(67.5) = 68. With G.9 (always-on post-G.15)
    // weighted aggregate over identical rows = same mean = 68.
    // formulaOverall = round(68*0.4 + 72*0.3 + 70*0.3) = 70.
    // Claude=72, Δ=2 → G.8 agreement-zone blend (always-on
    // post-G.15): round(0.6*72 + 0.4*70) = round(71.2) = 71.
    expect(call.score).toBe(71)
    expect(call.strongDimensions).toEqual(['ownership', 'relevance'])
    expect(call.weakDimensions).toEqual(['structure', 'specificity'])
  })
})
