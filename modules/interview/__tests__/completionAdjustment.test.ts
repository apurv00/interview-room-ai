/**
 * Work Item G.10 — partial-completion scoring.
 *
 * Unit tests for `computeCompletionAdjustment` (pure function, no
 * flag) plus integration tests through POST /api/generate-feedback
 * verifying the flag gate:
 *   - flag OFF → no multiplier, no clamp, no new red_flag
 *   - flag ON  → multiplier applies below 60% completion, confidence
 *                clamps to Low below 50%, end-reason red_flag added
 *   - flag ON + <3 answers → short-form feedback returned immediately
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import {
  computeCompletionAdjustment,
  FULL_CREDIT_COMPLETION_RATIO,
  SHORT_FORM_MIN_ANSWERS,
} from '@interview/services/eval/completionAdjustment'

// ─── Unit tests — the helper ───────────────────────────────────────────────

describe('computeCompletionAdjustment (G.10)', () => {
  describe('short-form guard', () => {
    it('flags <3 answers as short-form regardless of planned count', () => {
      for (const answered of [0, 1, 2]) {
        const r = computeCompletionAdjustment({
          plannedQuestionCount: 10,
          answeredCount: answered,
        })
        expect(r.shouldReturnShortForm).toBe(true)
        expect(r.scoreMultiplier).toBe(0)
        expect(r.clampConfidenceTo).toBe('Low')
        expect(r.redFlags[0]).toContain(`${SHORT_FORM_MIN_ANSWERS} answers are required`)
      }
    })

    it('does not flag 3 answers as short-form', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 3,
      })
      expect(r.shouldReturnShortForm).toBe(false)
    })
  })

  describe('completion multiplier', () => {
    it('returns 1.0 (no penalty) at ≥60% completion', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 6,
      })
      expect(r.scoreMultiplier).toBe(1)
      expect(r.clampConfidenceTo).toBeNull()
    })

    it('returns 1.0 for a complete interview', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 10,
      })
      expect(r.scoreMultiplier).toBe(1)
      expect(r.redFlags.length).toBe(0) // no red_flag when complete
    })

    it('tapers linearly below 60% completion', () => {
      // 5 of 10 = 50% → multiplier = 50/60 = 0.833
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 5,
      })
      expect(r.scoreMultiplier).toBeCloseTo(5 / (10 * FULL_CREDIT_COMPLETION_RATIO), 3)
    })

    it('produces a small multiplier at deep taper', () => {
      // 3 of 10 = 30% → multiplier = 30/60 = 0.5
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 3,
      })
      expect(r.scoreMultiplier).toBeCloseTo(0.5, 3)
    })

    it('defaults to 1.0 when plannedQuestionCount is unknown (legacy)', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 0, // legacy / missing G.7 field
        answeredCount: 5,
      })
      expect(r.scoreMultiplier).toBe(1)
      expect(r.shouldReturnShortForm).toBe(false)
    })
  })

  describe('confidence clamp', () => {
    it('clamps to Low when answered <50% of planned', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 4,
      })
      expect(r.clampConfidenceTo).toBe('Low')
    })

    it('does not clamp at exactly 50%', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 5,
      })
      expect(r.clampConfidenceTo).toBeNull()
    })

    it('does not clamp at ≥50%', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 7,
      })
      expect(r.clampConfidenceTo).toBeNull()
    })
  })

  describe('red flags', () => {
    it('produces a time_up variant message', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 7,
        endReason: 'time_up',
      })
      expect(r.redFlags[0]).toMatch(/timer expired/i)
    })

    it('produces a user_ended variant message', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 5,
        endReason: 'user_ended',
      })
      expect(r.redFlags[0]).toMatch(/candidate ended/i)
    })

    it('produces no red flag for a complete interview', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 5,
        answeredCount: 5,
      })
      expect(r.redFlags).toEqual([])
    })

    it('defaults endReason to "normal" when not provided', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 7,
      })
      expect(r.redFlags[0]).not.toMatch(/timer|candidate|limit|abandoned/i)
    })
  })

  describe('edge inputs', () => {
    it('tolerates non-numeric inputs via Number() coercion', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: NaN as unknown as number,
        answeredCount: 'oops' as unknown as number,
      })
      expect(r.shouldReturnShortForm).toBe(true)
      expect(r.scoreMultiplier).toBe(0)
    })

    it('tolerates negative answeredCount (treats as 0)', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: -5,
      })
      expect(r.shouldReturnShortForm).toBe(true)
    })

    it('computes completionRatio correctly', () => {
      const r = computeCompletionAdjustment({
        plannedQuestionCount: 10,
        answeredCount: 7,
      })
      expect(r.completionRatio).toBe(0.7)
    })
  })
})

// ─── Integration — flag gate through POST /api/generate-feedback ───────────

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
  getQuestionCount: (duration: number) => duration === 30 ? 16 : duration === 20 ? 11 : 6,
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

function evals(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    questionIndex: i, question: `Q${i + 1}?`, answer: 'A',
    relevance: 75, structure: 75, specificity: 75, ownership: 75,
    probeDecision: { shouldProbe: false },
  }))
}

function makeReq(opts: {
  evals: unknown[]
  plannedQuestionCount?: number
  answeredCount?: number
  endReason?: 'normal' | 'time_up' | 'user_ended' | 'usage_limit' | 'abandoned'
}) {
  const body: Record<string, unknown> = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [],
    evaluations: opts.evals,
    speechMetrics: [],
    sessionId: '507f1f77bcf86cd799439011',
  }
  if (opts.plannedQuestionCount != null) body.plannedQuestionCount = opts.plannedQuestionCount
  if (opts.answeredCount != null) body.answeredCount = opts.answeredCount
  if (opts.endReason) body.endReason = opts.endReason
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const claudeFeedback = {
  text: JSON.stringify({
    overall_score: 80,
    pass_probability: 'High',
    confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 80, strengths: [], weaknesses: [] },
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 80, engagement_score: 78, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 75 },
    },
    red_flags: [],
    top_3_improvements: ['A', 'B', 'C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
}

describe('POST /api/generate-feedback — G.10 flag gate', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockIsFeatureEnabled.mockReset()
  })

  // G.15b-6 inverted: pre-G.15 these were split into "flag OFF
  // (no multiplier)" and "flag ON (multiplier applied)" blocks.
  // Post-G.15 the completion adjustment is unconditional.
  // Expected `overall_score` numbers reflect G.8's now-unconditional
  // blend too: Claude=80 + formula=76 → agreement-zone blend 78.
  describe('post-G.15 unconditional behavior', () => {
    beforeEach(() => {
      // mockIsFeatureEnabled retains its mock — kept to confirm the
      // route doesn't actually consult the flag anymore for G.10
      // completion logic (the assertions hold the same regardless).
      // PR #321: `pathway_planner` IS preflighted now; returning true
      // keeps the pathway side-effect scheduled so no `pathway
      // unavailable` red_flag fires, preserving the completion-only
      // assertions in this suite.
      mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'pathway_planner')
    })

    it('<3 answers → short-form feedback, no LLM call', async () => {
      const res = await POST(makeReq({
        evals: evals(2), plannedQuestionCount: 10, answeredCount: 2, endReason: 'user_ended',
      }))
      const json = await res.json()

      expect(mockCompletion).not.toHaveBeenCalled()
      expect(json.overall_score).toBe(0)
      expect(json.confidence_level).toBe('Low')
      expect(json.red_flags.some((f: string) => f.includes('answers are required'))).toBe(true)
    })

    it('4 of 10 answers: G.8 blend → 78, then G.10 multiplier 0.667 → 52', async () => {
      mockCompletion.mockResolvedValueOnce(claudeFeedback)

      const res = await POST(makeReq({
        evals: evals(4), plannedQuestionCount: 10, answeredCount: 4, endReason: 'user_ended',
      }))
      const json = await res.json()

      // G.8 blend (always-on): Claude=80, formula=76, |Δ|=4 →
      //   round(0.6*80 + 0.4*76) = round(78.4) = 78.
      // G.10 multiplier 4/(10*0.6) = 0.667 → round(78*0.667) = 52.
      expect(json.overall_score).toBe(52)
      expect(json.confidence_level).toBe('Low')
      expect(json.red_flags.some((f: string) => f.includes('candidate ended'))).toBe(true)
    })

    it('6 of 10 answers: at full-credit threshold, no multiplier', async () => {
      mockCompletion.mockResolvedValueOnce(claudeFeedback)

      const res = await POST(makeReq({
        evals: evals(6), plannedQuestionCount: 10, answeredCount: 6, endReason: 'time_up',
      }))
      const json = await res.json()

      // G.8 blend = 78 (same input shape as 4-of-10 — perQAvg=75
      // unchanged because all rows are identical 75s).
      expect(json.overall_score).toBe(78)
      expect(json.confidence_level).not.toBe('Low')
      // Still pushes red_flag since answered < planned.
      expect(json.red_flags.some((f: string) => f.includes('timer expired'))).toBe(true)
    })

    it('full interview: no completion adjustment, no completion red_flag', async () => {
      mockCompletion.mockResolvedValueOnce(claudeFeedback)

      const res = await POST(makeReq({
        evals: evals(10), plannedQuestionCount: 10, answeredCount: 10, endReason: 'normal',
      }))
      const json = await res.json()

      expect(json.overall_score).toBe(78) // G.8 blend
      expect(json.red_flags.length).toBe(0)
    })

    it('legacy session (no planned count): falls back via getQuestionCount', async () => {
      mockCompletion.mockResolvedValueOnce(claudeFeedback)

      const res = await POST(makeReq({
        evals: evals(10),
        // plannedQuestionCount omitted — route falls back to getQuestionCount(30) = 16
      }))
      const json = await res.json()

      // 10 / 16 = 62.5% → above threshold, no penalty, no clamp.
      // G.8 blend (always-on) = 78.
      expect(json.overall_score).toBe(78)
      // answered < planned → red_flag still fires
      expect(json.red_flags.length).toBeGreaterThan(0)
    })
  })
})
