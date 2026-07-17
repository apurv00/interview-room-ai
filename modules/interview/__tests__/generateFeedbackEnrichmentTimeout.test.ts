/**
 * Codex P1 + P2 on PR #349 — enrichment is bounded by a timeout and its
 * token usage is folded into the api_call_feedback trackUsage record.
 *
 * Validates:
 *   1. A hung enrichment call (resolves after timeout) does NOT block
 *      the core feedback response — the route returns within the bound.
 *   2. On enrichment success, the trackUsage call's inputTokens/outputTokens
 *      include BOTH the core completion's tokens AND the enrichment
 *      completion's tokens (Codex P2 — cost accuracy).
 *   3. On enrichment timeout/failure, trackUsage records only the core
 *      tokens (enrichment usage is reported as {0,0}, so addition is a
 *      no-op — proving the bound doesn't corrupt billing).
 *
 * Pattern mirrors generateFeedbackTruncation.test.ts: passthrough
 * composeApiRoute, all post-feedback side effects mocked to no-ops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion, mockTrackUsage, mockWarn, mockError, mockInfo, mockInngestSend, mockFindByIdAndUpdate } = vi.hoisted(() => ({
  mockInngestSend: vi.fn().mockResolvedValue({ ids: ['evt-1'] }),
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockCompletion: vi.fn(),
  mockTrackUsage: vi.fn().mockResolvedValue(undefined),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
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
  aiLogger: { warn: mockWarn, error: mockError, info: mockInfo, debug: vi.fn() },
  logger: { warn: mockWarn, error: mockError, info: mockInfo, debug: vi.fn() },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    send: (...a: unknown[]) => mockInngestSend(...a),
    createFunction: (_cfg: unknown, handler: unknown) => ({ id: 'mock', handler }),
  },
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: mockTrackUsage,
}))

vi.mock('@shared/services/scoreTelemetry', () => ({
  recordScoreDelta: vi.fn().mockResolvedValue(null),
}))

vi.mock('@shared/services/feedbackLock', () => ({
  acquireFeedbackLock: vi.fn().mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true }),
  releaseFeedbackLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewSession: {
    findByIdAndUpdate: (...a: unknown[]) => mockFindByIdAndUpdate(...a),
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: () => true,
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
  JSON_OUTPUT_RULE: '',
}))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 99,
}))

vi.mock('@interview/config/speechMetrics', () => ({
  aggregateMetrics: () => ({ wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2 }),
  communicationScore: () => 72,
}))

vi.mock('@interview/services/core/skillLoader', () => ({
  getSkillSections: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/config/companyProfiles', () => ({
  findCompanyProfile: () => null,
}))

vi.mock('@interview/services/eval/evaluationEngine', () => ({
  evaluateSession: vi.fn().mockResolvedValue({}),
}))

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

import { POST } from '@/app/api/generate-feedback/route'

function makeEvaluations(n: number) {
  // Scores intentionally below 60 — the enrichment path only fires
  // when there are weak questions (avg < 60) to produce ideal_answers
  // for (2026-05-19 backfill: previously took top-3 weakest regardless
  // of score; now scoped to questions actually weak enough to need an
  // outline). Without this, weakestQuestionContext returns the empty
  // string and enrichment short-circuits before calling the LLM,
  // which breaks the token-aggregation + timeout assertions below.
  return Array.from({ length: n }, (_, i) => ({
    questionIndex: i,
    question: `Q${i + 1}?`,
    answer: `Answer ${i + 1}`,
    relevance: 40,
    structure: 35,
    specificity: 30,
    ownership: 45,
    probeDecision: { shouldProbe: false },
  }))
}

function makeRequest() {
  const body = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [
      { speaker: 'interviewer', text: 'Welcome', timestamp: 0 },
      { speaker: 'candidate', text: 'Thanks', timestamp: 1 },
    ],
    evaluations: makeEvaluations(6),
    speechMetrics: [],
    sessionId: '507f1f77bcf86cd799439011',
  }
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validCoreFeedback = JSON.stringify({
  overall_score: 72,
  pass_probability: 'Medium',
  confidence_level: 'High',
  dimensions: {
    answer_quality: { score: 70, strengths: ['Clear'], weaknesses: ['Vague metrics'] },
    communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
    engagement_signals: {
      score: 70, engagement_score: 68, confidence_trend: 'stable',
      energy_consistency: 0.7, composure_under_pressure: 65,
    },
  },
  red_flags: [],
  top_3_improvements: ['A', 'B', 'C'],
})

const validEnrichment = JSON.stringify({
  ideal_answers: [
    { questionIndex: 0, strongAnswer: 'Sample strong answer.', keyElements: ['STAR', 'metrics'] },
  ],
  drill_recommendations: [
    { skillArea: 'STAR', description: 'Practice structure.', practiceQuestions: ['Q1', 'Q2'] },
  ],
})

function coreResult() {
  return {
    text: validCoreFeedback,
    model: 'core-model',
    provider: 'test',
    inputTokens: 3000,
    outputTokens: 2500,
    usedFallback: false,
    truncated: false,
  }
}

function enrichmentResult(tokens = { input: 800, output: 600 }) {
  return {
    text: validEnrichment,
    model: 'enrichment-model',
    provider: 'test',
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    usedFallback: false,
    truncated: false,
  }
}

describe('POST /api/generate-feedback — enrichment bounding (Codex P1) + token aggregation (Codex P2)', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockTrackUsage.mockReset()
    mockTrackUsage.mockResolvedValue(undefined)
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
    vi.useRealTimers()
  })

  // ── 2026-07-17: enrichment left the request path (async enrichFeedbackJob) ──
  // The old inline-race cases (token fold-in, weak-question prompt shape,
  // the 30s hang test) are superseded: prompt-shape/cap coverage lives in
  // feedbackEnrichment.test.ts; the job's behavior in enrichFeedbackJob.test.ts.
  // These cases pin the ROUTE side of the async contract.

  it('makes exactly one completion call and ships empty enrichment arrays', async () => {
    mockCompletion.mockResolvedValueOnce(coreResult())

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    expect(json.ideal_answers).toEqual([])
    expect(json.drill_recommendations).toEqual([])
  })

  it('emits feedback/enrich.requested (reason post-feedback) after persist', async () => {
    mockCompletion.mockResolvedValueOnce(coreResult())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    await new Promise((r) => setImmediate(r))

    const sendCall = mockInngestSend.mock.calls.find(
      (c) => (c[0] as { name?: string })?.name === 'feedback/enrich.requested',
    )
    expect(sendCall).toBeDefined()
    expect((sendCall![0] as { data: { reason: string; sessionId: string } }).data).toMatchObject({
      reason: 'post-feedback',
      sessionId: '507f1f77bcf86cd799439011',
    })
  })

  it('persists enrichmentStatus pending atomically with the feedback write', async () => {
    mockCompletion.mockResolvedValueOnce(coreResult())

    await POST(makeRequest())
    await new Promise((r) => setImmediate(r))

    const persistCall = mockFindByIdAndUpdate.mock.calls.find(
      (c) => (c[1] as { feedback?: unknown })?.feedback !== undefined,
    )
    expect(persistCall).toBeDefined()
    expect((persistCall![1] as { enrichmentStatus?: string }).enrichmentStatus).toBe('pending')
  })

  it('bills only core tokens in api_call_feedback (enrichment bills from the job)', async () => {
    mockCompletion.mockResolvedValueOnce(coreResult())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    const feedbackCall = mockTrackUsage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'api_call_feedback',
    )
    expect(feedbackCall).toBeDefined()
    const usage = feedbackCall![0] as { inputTokens: number; outputTokens: number; success: boolean }
    expect(usage.success).toBe(true)
    expect(usage.inputTokens).toBe(3000)
    expect(usage.outputTokens).toBe(2500)
  })

  it('aggregates core + repair tokens when structured repair fires', async () => {
    // First core completion returns valid JSON shape but missing the
    // required `overall_score` (typeof !== 'number') so requireCoreFeedback
    // throws FeedbackCoreParseError → repair branch runs. The repair
    // succeeds. trackUsage must record BOTH calls' tokens; pre-fix the
    // `result = repairResult` overwrite silently dropped core's tokens.
    const malformedCoreText = JSON.stringify({
      overall_score: 'not a number',
      pass_probability: 'Medium',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 70, strengths: [], weaknesses: [] },
        communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: {
          score: 70, engagement_score: 68, confidence_trend: 'stable',
          energy_consistency: 0.7, composure_under_pressure: 65,
        },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
    })

    mockCompletion
      // 1. core call — malformed; triggers repair branch
      .mockResolvedValueOnce({
        text: malformedCoreText,
        model: 'core-model',
        provider: 'test',
        inputTokens: 3000,
        outputTokens: 2500,
        usedFallback: false,
        truncated: false,
      })
      // 2. repair call — valid
      .mockResolvedValueOnce({
        text: validCoreFeedback,
        model: 'repair-model',
        provider: 'test',
        inputTokens: 1200,
        outputTokens: 900,
        usedFallback: false,
        truncated: false,
      })
      // (no 3rd call — enrichment is async since 2026-07-17)

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    const feedbackCall = mockTrackUsage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'api_call_feedback',
    )
    expect(feedbackCall).toBeDefined()
    const usage = feedbackCall![0] as { inputTokens: number; outputTokens: number; success: boolean }
    expect(usage.success).toBe(true)
    // Core (3000 + 2500) + Repair (1200 + 900) + Enrichment (800 + 600)
    // = 5000 in + 4000 out.
    expect(usage.inputTokens).toBe(4200) // core 3000 + repair 1200
    expect(usage.outputTokens).toBe(3400) // core 2500 + repair 900
  })

  // ── Codex P2 on 2026-05-12: deterministic communication metrics ──────────
  it('overrides hallucinated communication metrics with server-computed aggMetrics', async () => {
    // Model returns plausibly-shaped but wildly inaccurate values. The
    // route must replace them with the aggMetrics values mocked above
    // (wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2).
    // Pre-fix, only `score` was overridden — the other four numbers
    // were trusted as-is and could mislead downstream coaching logic.
    const driftingCore = JSON.stringify({
      overall_score: 72,
      pass_probability: 'Medium',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 70, strengths: [], weaknesses: [] },
        communication: {
          score: 50, // wrong; route must override to commScore=72
          wpm: 999, // hallucinated
          filler_rate: 0.99, // hallucinated
          pause_score: 5, // hallucinated
          rambling_index: 9.9, // hallucinated
        },
        engagement_signals: {
          score: 70, engagement_score: 68, confidence_trend: 'stable',
          energy_consistency: 0.7, composure_under_pressure: 65,
        },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
    })

    mockCompletion
      .mockResolvedValueOnce({
        text: driftingCore,
        model: 'core-model',
        provider: 'test',
        inputTokens: 3000,
        outputTokens: 2500,
        usedFallback: false,
        truncated: false,
      })
      .mockResolvedValueOnce(enrichmentResult())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.dimensions.communication.score).toBe(72)
    expect(json.dimensions.communication.wpm).toBe(140)
    expect(json.dimensions.communication.filler_rate).toBe(0.04)
    expect(json.dimensions.communication.pause_score).toBe(70)
    expect(json.dimensions.communication.rambling_index).toBe(0.2)
  })
})
