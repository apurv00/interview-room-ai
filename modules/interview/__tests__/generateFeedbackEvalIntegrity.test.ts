/**
 * Work Item G.4 — eval integrity in /api/generate-feedback.
 *
 * Validates that evaluations marked `status: 'failed'` (from G.3) are
 * EXCLUDED from the deterministic per-question answer-quality average
 * rather than averaged in with their 60/55/55/60 placeholder
 * fallback shape. A single failed row dragging a 9-question average
 * toward 57 is the exact silent-corruption failure mode G.4 closes.
 *
 * Covers:
 *   - `computePerQAverage` helper — happy path, failed-row exclusion,
 *     truncated-row inclusion, all-failed edge case.
 *   - End-to-end: a session with 3 ok + 1 failed eval produces
 *     answer_quality.score equal to the average of the 3 ok rows,
 *     not the mean-with-fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Helper unit tests ─────────────────────────────────────────────────────

import { computePerQAverage } from '@/app/api/generate-feedback/route'

describe('computePerQAverage (G.4)', () => {
  it('averages all rows when none are failed', () => {
    const evals = [
      { relevance: 80, structure: 70, specificity: 60, ownership: 70 }, // 70
      { relevance: 60, structure: 60, specificity: 60, ownership: 60 }, // 60
    ]
    const r = computePerQAverage(evals)
    expect(r.average).toBe(65)
    expect(r.usedCount).toBe(2)
    expect(r.skippedFailedCount).toBe(0)
  })

  it('excludes rows with status="failed"', () => {
    const evals = [
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 }, // 80
      { relevance: 60, structure: 55, specificity: 55, ownership: 60, status: 'failed' }, // fabricated placeholder
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 }, // 80
    ]
    const r = computePerQAverage(evals)
    expect(r.average).toBe(80) // pure mean of the two clean rows, no placeholder drag
    expect(r.usedCount).toBe(2)
    expect(r.skippedFailedCount).toBe(1)
  })

  it('includes rows with status="truncated" (partial data is best-effort real)', () => {
    const evals = [
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 }, // 80
      { relevance: 60, structure: 55, specificity: 50, ownership: 60, status: 'truncated' }, // 56.25
    ]
    const r = computePerQAverage(evals)
    // (80 + 56.25) / 2 = 68.125 → 68
    expect(r.average).toBe(68)
    expect(r.usedCount).toBe(2)
    expect(r.skippedFailedCount).toBe(0)
  })

  it('returns 0 and usedCount=0 when all rows are failed', () => {
    const evals = [
      { relevance: 60, structure: 55, specificity: 55, ownership: 60, status: 'failed' },
      { relevance: 60, structure: 55, specificity: 55, ownership: 60, status: 'failed' },
    ]
    const r = computePerQAverage(evals)
    expect(r.average).toBe(0)
    expect(r.usedCount).toBe(0)
    expect(r.skippedFailedCount).toBe(2)
  })

  it('tolerates missing dimensions as 0 (status=ok path is unchanged)', () => {
    const evals = [
      { relevance: 80, structure: 80 }, // missing specificity + ownership → (80+80+0+0)/4 = 40
    ]
    const r = computePerQAverage(evals)
    expect(r.average).toBe(40)
    expect(r.usedCount).toBe(1)
  })

  it('handles explicit status="ok" the same as absent status', () => {
    const a = computePerQAverage([{ relevance: 70, structure: 70, specificity: 70, ownership: 70 }])
    const b = computePerQAverage([{ relevance: 70, structure: 70, specificity: 70, ownership: 70, status: 'ok' }])
    expect(a).toEqual(b)
  })

  it('returns 0 on empty input', () => {
    const r = computePerQAverage([])
    expect(r).toEqual({ average: 0, usedCount: 0, skippedFailedCount: 0 })
  })
})

// ─── End-to-end: failed-row exclusion propagates to feedback.answer_quality ───

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
  InterviewSession: { findByIdAndUpdate: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))
vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 99,
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

import { POST } from '@/app/api/generate-feedback/route'

function okEval(qi: number, dim: number) {
  return {
    questionIndex: qi,
    question: `Q${qi + 1}?`,
    answer: 'A',
    relevance: dim,
    structure: dim,
    specificity: dim,
    ownership: dim,
    status: 'ok' as const,
    probeDecision: { shouldProbe: false },
  }
}

function failedEval(qi: number) {
  // The fabricated 60/55/55/60 shape evaluate-answer emits on LLM failure.
  return {
    questionIndex: qi,
    question: `Q${qi + 1}?`,
    answer: 'A',
    relevance: 60,
    structure: 55,
    specificity: 55,
    ownership: 60,
    status: 'failed' as const,
    probeDecision: { shouldProbe: false },
  }
}

function makeRequest(evaluations: unknown[]) {
  const body = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [],
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

const happyFeedback = {
  text: JSON.stringify({
    overall_score: 72,
    pass_probability: 'Medium',
    confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 99, strengths: [], weaknesses: [] }, // deliberately wrong — deterministic override should replace
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
    },
    red_flags: [],
    top_3_improvements: ['A', 'B', 'C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
}

describe('POST /api/generate-feedback — G.4 excludes failed evals from aggregation', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockInfo.mockReset()
  })

  it('answer_quality.score = mean of ok rows, ignoring the failed placeholder', async () => {
    mockCompletion.mockResolvedValueOnce(happyFeedback)
    // 3 ok @ 80 + 1 failed @ placeholder (57.5)
    const evals = [okEval(0, 80), okEval(1, 80), okEval(2, 80), failedEval(3)]

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    // Pre-G.4: (80+80+80+57.5)/4 = 74.375 → 74
    // Post-G.4: failed row excluded → 80
    expect(json.dimensions.answer_quality.score).toBe(80)
    // red_flag exists noting the 1 failed row
    expect(json.red_flags.some((f: string) => f.includes('excluded from the answer-quality'))).toBe(true)
  })

  it('returns 0 answer_quality when every row is failed', async () => {
    mockCompletion.mockResolvedValueOnce(happyFeedback)
    const evals = [failedEval(0), failedEval(1)]

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    expect(json.dimensions.answer_quality.score).toBe(0)
  })

  it('does not skip truncated rows (they are best-effort real data)', async () => {
    mockCompletion.mockResolvedValueOnce(happyFeedback)
    const truncatedEval = {
      ...okEval(3, 60), status: 'truncated' as const,
    }
    const evals = [okEval(0, 80), okEval(1, 80), okEval(2, 80), truncatedEval]

    const res = await POST(makeRequest(evals))
    const json = await res.json()

    // All 4 included: (80*3 + 60)/4 = 75
    expect(json.dimensions.answer_quality.score).toBe(75)
  })
})
