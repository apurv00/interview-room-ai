/**
 * Work Item G.8 — blend integration through /api/generate-feedback.
 *
 * Validates:
 *   1. With flag OFF (default), overall_score reproduces the pre-G.8
 *      formula-only value byte-for-byte — Claude's raw value is
 *      discarded as before. This is the ramp-safety contract.
 *   2. With flag ON, Claude's raw value is blended in; the shipped
 *      overall_score escapes the compressed mid-band.
 *   3. Disagreement zone (|Δ|>20) pulls the blend toward the formula
 *      — a hallucinated Claude 95 does not dominate.
 *   4. Telemetry records `deterministicOverallScore = formulaOverall`
 *      (not the blended value) so G.1 baselines remain comparable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion, mockRecordScoreDelta, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockRecordScoreDelta: vi.fn(),
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
vi.mock('@shared/services/scoreTelemetry', () => ({
  recordScoreDelta: (...args: unknown[]) => mockRecordScoreDelta(...args),
}))
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
  communicationScore: () => 70,
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

// Evaluations tuned so the deterministic formula resolves to a known
// mid-band number: per-Q avg of 70 across 5 rows.
function evals5at70() {
  return Array.from({ length: 5 }, (_, i) => ({
    questionIndex: i,
    question: `Q${i + 1}?`,
    answer: 'A',
    relevance: 70,
    structure: 70,
    specificity: 70,
    ownership: 70,
    probeDecision: { shouldProbe: false },
  }))
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

function claudeFeedback(overall: number, engagement: number = 70) {
  return {
    text: JSON.stringify({
      overall_score: overall,
      pass_probability: 'Medium',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 80, strengths: [], weaknesses: [] },
        communication: { score: 70, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: { score: engagement, engagement_score: engagement, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
    }),
    model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
  }
}

describe('POST /api/generate-feedback — G.8 blend integration', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockRecordScoreDelta.mockReset()
    mockRecordScoreDelta.mockResolvedValue(null) // must be thenable for `.catch()`
    mockIsFeatureEnabled.mockReset()
  })

  describe('unconditional blend (post-G.15 — flag-gate removed)', () => {
    // G.15b-4 inverted this test: pre-G.15, with the flag OFF, the
    // route returned the formula-only value. Post-G.15 the blend is
    // unconditional, so even with isFeatureEnabled returning false
    // for everything, Claude's value is still blended in. This
    // test now verifies the blend happens regardless of flag state —
    // which is the permanent behavior.
    it('blends Claude + formula regardless of isFeatureEnabled state', async () => {
      mockIsFeatureEnabled.mockImplementation(() => false)
      // Claude=88, formula=70, |Δ|=18 (within agreement threshold 20):
      // 0.6*88 + 0.4*70 = 52.8 + 28 = 80.8 → 81.
      mockCompletion.mockResolvedValueOnce(claudeFeedback(88, 70))

      const res = await POST(makeRequest(evals5at70()))
      const json = await res.json()

      expect(json.overall_score).toBe(81)
    })
  })

  describe('flag ON (G.8 blend)', () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'scoring_v2_overall')
    })

    it('blends Claude + formula in the agreement zone', async () => {
      // Claude=85, formula=70, Δ=15 (within threshold 20) → agreement.
      // 0.6*85 + 0.4*70 = 51 + 28 = 79.
      mockCompletion.mockResolvedValueOnce(claudeFeedback(85, 70))

      const res = await POST(makeRequest(evals5at70()))
      const json = await res.json()

      expect(json.overall_score).toBe(79)
    })

    it('engages safety clamp when Claude disagrees wildly', async () => {
      // Claude=95, formula=70, Δ=25 > 20 → disagreement mode.
      // 0.3*95 + 0.7*70 = 28.5 + 49 = 77.5 → 78.
      mockCompletion.mockResolvedValueOnce(claudeFeedback(95, 70))

      const res = await POST(makeRequest(evals5at70()))
      const json = await res.json()

      expect(json.overall_score).toBe(78)
    })

    it('falls back to formula when Claude value missing', async () => {
      // Mock a Claude response with no overall_score.
      const mockResp = {
        text: JSON.stringify({
          pass_probability: 'Medium',
          dimensions: {
            answer_quality: { score: 70, strengths: [], weaknesses: [] },
            communication: { score: 70, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
            engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
          },
          red_flags: [],
          top_3_improvements: ['A', 'B', 'C'],
        }),
        model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
      }
      mockCompletion.mockResolvedValueOnce(mockResp)

      const res = await POST(makeRequest(evals5at70()))
      const json = await res.json()

      expect(json.overall_score).toBe(70) // formula
    })
  })

  describe('telemetry (G.1 stays comparable)', () => {
    it('records deterministicOverallScore = formulaOverall (not blended) even when flag ON', async () => {
      mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'scoring_v2_overall')
      mockCompletion.mockResolvedValueOnce(claudeFeedback(85, 70))

      await POST(makeRequest(evals5at70()))

      // Find the success-path recordScoreDelta call (skip the
      // parse-failed or outer-catch ones which shouldn't fire here).
      const successCall = mockRecordScoreDelta.mock.calls.find(
        (c) => (c[0] as { recordReason?: string }).recordReason === 'ok',
      )
      expect(successCall).toBeDefined()
      const arg = successCall![0] as Record<string, unknown>
      expect(arg.claudeOverallScore).toBe(85)
      expect(arg.deterministicOverallScore).toBe(70) // formula, NOT 79 (blended)
    })
  })
})
