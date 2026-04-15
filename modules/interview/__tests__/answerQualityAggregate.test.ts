/**
 * Work Item G.9 — dimension-aware answer_quality aggregate.
 *
 * Unit tests for `computeAnswerQualityAggregate` (median, top3Mean,
 * bottom3Mean, weighted) in perQAggregation.ts, plus an integration
 * test through POST /api/generate-feedback proving that the flag
 * gate is respected:
 *   - flag OFF (default) → answer_quality.score = flat mean (pre-G.9)
 *   - flag ON            → answer_quality.score = weighted aggregate
 *
 * Doesn't re-test `computePerQAverage` basics — those are covered in
 * generateFeedbackEvalIntegrity.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { computeAnswerQualityAggregate } from '@interview/services/eval/perQAggregation'

// ─── Unit tests — the helper ───────────────────────────────────────────────

describe('computeAnswerQualityAggregate (G.9)', () => {
  it('returns the expected fields on a happy-path input', () => {
    const evals = [
      { relevance: 70, structure: 70, specificity: 70, ownership: 70 },
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 },
      { relevance: 60, structure: 60, specificity: 60, ownership: 60 },
    ]
    const r = computeAnswerQualityAggregate(evals)
    expect(r.usedCount).toBe(3)
    expect(r.average).toBe(70)
    expect(r.median).toBe(70)
    expect(r.top3Mean).toBe(70) // mean of all 3 = mean
    expect(r.bottom3Mean).toBe(70)
    // weighted = 0.4*70 + 0.3*70 + 0.2*70 + 0.1*70 = 70
    expect(r.weighted).toBe(70)
  })

  it('weighted formula lifts scores when top answers are strong (vs flat mean)', () => {
    // Pre-G.9 regression scenario: one 90-scoring answer hidden among
    // nine mediocre 55s. Flat mean = 58.5 (rounded 59). Weighted
    // should bring the top moment's signal into the user-visible
    // number.
    const nineMediocre = Array.from({ length: 9 }, () => ({
      relevance: 55, structure: 55, specificity: 55, ownership: 55,
    }))
    const oneStrong = { relevance: 90, structure: 90, specificity: 90, ownership: 90 }
    const r = computeAnswerQualityAggregate([...nineMediocre, oneStrong])
    expect(r.average).toBe(59) // 58.5 rounded
    expect(r.median).toBe(55)
    // top3 = mean of [90, 55, 55] = 66.67 → 67
    expect(r.top3Mean).toBe(67)
    expect(r.bottom3Mean).toBe(55)
    // weighted = 0.4*58.5 + 0.3*66.67 + 0.2*55 + 0.1*55 = 23.4 + 20 + 11 + 5.5 = 59.9 → 60
    expect(r.weighted).toBe(60)
    // Delta: the strong answer shows up — weighted > flat mean.
    expect(r.weighted).toBeGreaterThan(r.average)
  })

  it('weighted formula lowers scores when bottom answers are weak', () => {
    // Inverse of the above: one 20-scoring pivot among nine 75s.
    const nineGood = Array.from({ length: 9 }, () => ({
      relevance: 75, structure: 75, specificity: 75, ownership: 75,
    }))
    const onePivot = { relevance: 20, structure: 20, specificity: 20, ownership: 20 }
    const r = computeAnswerQualityAggregate([...nineGood, onePivot])
    expect(r.average).toBe(70) // 69.5 rounded up
    expect(r.median).toBe(75)
    expect(r.top3Mean).toBe(75)
    // bottom3 = mean of [20, 75, 75] = 56.67 → 57
    expect(r.bottom3Mean).toBe(57)
    // weighted = 0.4*69.5 + 0.3*75 + 0.2*75 + 0.1*56.67 = 27.8 + 22.5 + 15 + 5.67 ≈ 71
    expect(r.weighted).toBe(71)
    // Weighted acknowledges the weak moment — closer to mean than
    // the top3-dominated case above, but still reflects reality.
  })

  it('excludes status="failed" rows from all aggregates', () => {
    const evals = [
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 },
      { relevance: 60, structure: 55, specificity: 55, ownership: 60, status: 'failed' },
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 },
    ]
    const r = computeAnswerQualityAggregate(evals)
    expect(r.usedCount).toBe(2)
    expect(r.skippedFailedCount).toBe(1)
    expect(r.average).toBe(80)
    expect(r.median).toBe(80)
    expect(r.top3Mean).toBe(80) // only 2 rows; window collapses
    expect(r.bottom3Mean).toBe(80)
    expect(r.weighted).toBe(80)
  })

  it('returns zeros when every row is failed', () => {
    const evals = [
      { relevance: 60, structure: 55, specificity: 55, ownership: 60, status: 'failed' },
    ]
    const r = computeAnswerQualityAggregate(evals)
    expect(r.usedCount).toBe(0)
    expect(r.skippedFailedCount).toBe(1)
    expect(r.average).toBe(0)
    expect(r.median).toBe(0)
    expect(r.top3Mean).toBe(0)
    expect(r.bottom3Mean).toBe(0)
    expect(r.weighted).toBe(0)
  })

  it('handles a single usable row without collapsing', () => {
    const evals = [{ relevance: 80, structure: 80, specificity: 80, ownership: 80 }]
    const r = computeAnswerQualityAggregate(evals)
    expect(r.usedCount).toBe(1)
    expect(r.average).toBe(80)
    expect(r.median).toBe(80)
    expect(r.top3Mean).toBe(80)
    expect(r.bottom3Mean).toBe(80)
    expect(r.weighted).toBe(80)
  })

  it('computes median correctly for even-length arrays', () => {
    const evals = [
      { relevance: 60, structure: 60, specificity: 60, ownership: 60 }, // 60
      { relevance: 70, structure: 70, specificity: 70, ownership: 70 }, // 70
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 }, // 80
      { relevance: 90, structure: 90, specificity: 90, ownership: 90 }, // 90
    ]
    const r = computeAnswerQualityAggregate(evals)
    // Middle pair: 70, 80 → median 75
    expect(r.median).toBe(75)
  })

  it('does not mutate input order', () => {
    const evals = [
      { relevance: 90, structure: 90, specificity: 90, ownership: 90 },
      { relevance: 50, structure: 50, specificity: 50, ownership: 50 },
    ]
    const original = [...evals]
    computeAnswerQualityAggregate(evals)
    expect(evals).toEqual(original)
  })
})

// ─── Integration — flag gate through POST /api/generate-feedback ──────────

const { mockCompletion, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
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
  aiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => mockIsFeatureEnabled(flag),
}))
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

function mediocreEvals() {
  // 9 rows at 55 + 1 row at 90 — the pre-G.9 regression scenario.
  const nineMediocre = Array.from({ length: 9 }, (_, i) => ({
    questionIndex: i, question: `Q${i + 1}?`, answer: 'A',
    relevance: 55, structure: 55, specificity: 55, ownership: 55,
    probeDecision: { shouldProbe: false },
  }))
  const oneStrong = {
    questionIndex: 9, question: 'Q10?', answer: 'Strong A',
    relevance: 90, structure: 90, specificity: 90, ownership: 90,
    probeDecision: { shouldProbe: false },
  }
  return [...nineMediocre, oneStrong]
}

function makeReq(evaluations: unknown[]) {
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      transcript: [],
      evaluations,
      speechMetrics: [],
      sessionId: '507f1f77bcf86cd799439011',
    }),
  })
}

const neutralFeedback = {
  text: JSON.stringify({
    overall_score: 70,
    pass_probability: 'Medium',
    confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 99, strengths: [], weaknesses: [] }, // deliberately wrong — must be overridden
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
    },
    red_flags: [],
    top_3_improvements: ['A', 'B', 'C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
}

describe('POST /api/generate-feedback — G.9 flag gate on answer_quality.score', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockIsFeatureEnabled.mockReset()
  })

  it('answer_quality.score = weighted aggregate (post-G.15 unconditional)', async () => {
    // G.15b-5 inverted this from a flag-OFF "expect flat mean" test.
    // Post-G.15 the weighted aggregate is the only path. weighted
    // (per the unit test above) = 60 vs flat mean = 59 — the
    // single point of "spread preservation" survives the rebalance.
    mockIsFeatureEnabled.mockImplementation(() => false)
    mockCompletion.mockResolvedValueOnce(neutralFeedback)

    const res = await POST(makeReq(mediocreEvals()))
    const json = await res.json()

    expect(json.dimensions.answer_quality.score).toBe(60)
  })

  it('weighted AQ with flags-mocked-ON produces the same value as flags-OFF', async () => {
    // Post-G.15 the flag check is gone; the test now confirms that
    // the route is genuinely flag-independent at the AQ site.
    mockIsFeatureEnabled.mockImplementation(() => false)
    mockCompletion.mockResolvedValueOnce(neutralFeedback)
    const resOff = await POST(makeReq(mediocreEvals()))
    const jsonOff = await resOff.json()

    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'scoring_v2_aq')
    mockCompletion.mockResolvedValueOnce(neutralFeedback)
    const resOn = await POST(makeReq(mediocreEvals()))
    const jsonOn = await resOn.json()

    expect(jsonOff.overall_score).toBe(jsonOn.overall_score)
    expect(jsonOff.dimensions.answer_quality.score).toBe(jsonOn.dimensions.answer_quality.score)
  })
})
