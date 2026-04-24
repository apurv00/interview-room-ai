/**
 * Work Item G.3 — truncation detection in /api/generate-feedback.
 *
 * Validates:
 *   1. First completion truncated → retry with maxTokens: 8000.
 *   2. Retry OK → return normal feedback, no red_flag.
 *   3. Retry still truncated → push a red_flag, clamp
 *      confidence_level='Low'.
 *   4. Upstream eval rows with status='truncated'/'failed' → surface as
 *      red_flags and down-rate confidence_level based on ratio.
 *
 * Uses passthrough composeApiRoute so the handler body runs unguarded.
 * Downstream post-feedback side effects (competency, session summary,
 * pathway planner, multimodal) are mocked to no-ops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion, mockWarn, mockError, mockInfo } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
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

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
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
    findByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@shared/featureFlags', () => ({
  // Match prod defaults (see shared/featureFlags.ts). PR #321: pathway_planner
  // flag-off pushes a new red_flag, which would break the "red_flags is empty"
  // truncation-path assertions in this file. Production default is true, so
  // flip here to keep the truncation tests focused on their actual concern.
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
  aggregateMetrics: () => ({
    wpm: 140,
    fillerRate: 0.04,
    pauseScore: 70,
    ramblingIndex: 0.2,
  }),
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEvaluations(n: number, status?: 'ok' | 'truncated' | 'failed') {
  return Array.from({ length: n }, (_, i) => ({
    questionIndex: i,
    question: `Q${i + 1}?`,
    answer: `Answer ${i + 1}`,
    relevance: 70,
    structure: 65,
    specificity: 60,
    ownership: 75,
    ...(status && { status }),
    probeDecision: { shouldProbe: false },
  }))
}

function makeRequest(evaluations: unknown[] = makeEvaluations(6)) {
  const body = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [
      { speaker: 'interviewer', text: 'Welcome', timestamp: 0 },
      { speaker: 'candidate', text: 'Thanks', timestamp: 1 },
    ],
    evaluations,
    speechMetrics: [],
    sessionId: '507f1f77bcf86cd799439011',
  }
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validFeedback = JSON.stringify({
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

function completionResult(text: string, truncated: boolean) {
  return {
    text,
    model: 'test-model',
    provider: 'test-provider',
    inputTokens: 3000,
    outputTokens: truncated ? 6000 : 2500,
    usedFallback: false,
    truncated,
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/generate-feedback — G.3 truncation handling', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
  })

  it('no retry on non-truncated response; no red_flag', async () => {
    mockCompletion.mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletion).toHaveBeenCalledTimes(1)
    expect(json.red_flags).toEqual([])
    expect(json.confidence_level).not.toBe('Low')
  })

  it('retries with maxTokens=8000 when first response is truncated', async () => {
    mockCompletion
      .mockResolvedValueOnce(completionResult(validFeedback, true))
      .mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletion).toHaveBeenCalledTimes(2)
    const retryCall = mockCompletion.mock.calls[1][0] as { maxTokens?: number }
    expect(retryCall.maxTokens).toBe(8000)
    expect(json.red_flags).toEqual([])
    expect(json.confidence_level).not.toBe('Low')
  })

  it('clamps confidence=Low and adds red_flag when retry also truncates', async () => {
    mockCompletion
      .mockResolvedValueOnce(completionResult(validFeedback, true))
      .mockResolvedValueOnce(completionResult(validFeedback, true))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletion).toHaveBeenCalledTimes(2)
    expect(json.confidence_level).toBe('Low')
    expect(json.red_flags.some((f: string) =>
      f.toLowerCase().includes('truncated'))).toBe(true)
  })

  it('surfaces upstream truncated evaluation rows as red_flags', async () => {
    const evals = [
      ...makeEvaluations(4, 'ok'),
      ...makeEvaluations(2, 'truncated'),
    ]
    mockCompletion.mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    expect(json.red_flags.some((f: string) =>
      f.includes('could not be fully scored'))).toBe(true)
  })

  it('surfaces upstream failed evaluation rows as red_flags', async () => {
    const evals = [
      ...makeEvaluations(5, 'ok'),
      ...makeEvaluations(1, 'failed'),
    ]
    mockCompletion.mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    expect(json.red_flags.some((f: string) =>
      f.includes('could not be scored'))).toBe(true)
  })

  it('clamps confidence=Low when ≥20% of evals had integrity issues', async () => {
    // 8 ok + 2 truncated = 20% problem ratio → threshold hit
    const evals = [
      ...makeEvaluations(8, 'ok'),
      ...makeEvaluations(2, 'truncated'),
    ]
    mockCompletion.mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    expect(json.confidence_level).toBe('Low')
  })

  it('downgrades High→Medium when <20% but >0 of evals had integrity issues', async () => {
    // 9 ok + 1 truncated = 10% problem ratio → below 20% but nonzero
    const evals = [
      ...makeEvaluations(9, 'ok'),
      ...makeEvaluations(1, 'truncated'),
    ]
    mockCompletion.mockResolvedValueOnce(completionResult(validFeedback, false))

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    expect(json.confidence_level).toBe('Medium')
  })
})
