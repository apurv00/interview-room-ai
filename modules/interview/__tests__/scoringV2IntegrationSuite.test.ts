/**
 * G.15a — Scoring-V2 integration smoke suite.
 *
 * Runs the feedback-generation pipeline end-to-end with EVERY
 * scoring-V2 flag turned ON simultaneously, simulating the
 * post-G.15 production state (where flags are removed entirely and
 * the new behavior is always-on). Purpose: prove the combined new
 * behavior across G.8/G.9/G.10/G.11/G.12/G.13/G.14 produces
 * coherent output for a range of realistic session shapes BEFORE
 * we delete the flag-OFF branches.
 *
 * This file is intentionally additive — it does not replace any
 * existing per-work-item integration tests. Those tests continue
 * to pin the individual flag-gate contracts; this file tests the
 * combined state.
 *
 * Chunk 1: scaffolding + 2 scenarios.
 *   - complete-strong-session (10 answers, all 80+)
 *   - short-form guard (2 answers → refuse to score)
 * Subsequent chunks add more scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion, mockUpdatePracticeStats } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockUpdatePracticeStats: vi.fn(),
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
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'u1', practiceStats: {} }) }) }) },
  InterviewSession: { findByIdAndUpdate: vi.fn().mockResolvedValue(undefined) },
}))

// The key mock: ALL scoring_v2_* flags + compact_transcript +
// xp_from_feedback are ON simultaneously. This is the post-G.15
// prod state.
const SCORING_V2_FLAGS = new Set([
  'scoring_v2_overall',
  'scoring_v2_aq',
  'scoring_v2_completion',
  'scoring_v2_ceiling',
  'compact_transcript',
  'xp_from_feedback',
  'score_telemetry',
])
vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (flag: string) => SCORING_V2_FLAGS.has(flag),
}))

vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 99,
  getQuestionCount: (d: number) => d === 30 ? 16 : d === 20 ? 11 : 6,
}))

vi.mock('@interview/config/speechMetrics', () => ({
  aggregateMetrics: () => ({ wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2 }),
  communicationScore: () => 75,
}))

vi.mock('@interview/services/core/skillLoader', () => ({ getSkillSections: vi.fn().mockResolvedValue(null) }))
vi.mock('@interview/config/companyProfiles', () => ({ findCompanyProfile: () => null }))
vi.mock('@interview/services/eval/evaluationEngine', () => ({
  evaluateSession: vi.fn().mockResolvedValue({}),
  getScoringDimensions: vi.fn().mockResolvedValue([]),
  buildRubricPromptSection: () => '',
}))
vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: vi.fn().mockResolvedValue(null),
  getOrLoadResumeContext: vi.fn().mockResolvedValue(null),
}))
vi.mock('@interview/services/core/sessionConfigCache', () => ({
  getOrLoadSessionConfig: vi.fn().mockResolvedValue(null),
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
vi.mock('@learn/services/practiceStatsService', () => ({
  updatePracticeStats: (...args: unknown[]) => mockUpdatePracticeStats(...args),
  deriveStrongWeakDimensions: () => ({
    strongDimensions: ['ownership', 'relevance'],
    weakDimensions: ['structure', 'specificity'],
  }),
}))

import { POST } from '@/app/api/generate-feedback/route'

// ─── Fixture builders ─────────────────────────────────────────────

function evalRow(qi: number, score: number, overrides: Record<string, unknown> = {}) {
  return {
    questionIndex: qi, question: `Q${qi + 1}?`, answer: `Answer text for Q${qi + 1}.`,
    relevance: score, structure: score, specificity: score, ownership: score,
    answerSummary: `Summary for Q${qi + 1}.`,
    probeDecision: { shouldProbe: false },
    ...overrides,
  }
}

function transcriptFor(evaluations: Array<{ questionIndex: number; question?: string; answer?: string }>) {
  return evaluations.flatMap((ev) => [
    { speaker: 'interviewer' as const, text: ev.question ?? `Q${ev.questionIndex + 1}?`, timestamp: ev.questionIndex * 60, questionIndex: ev.questionIndex },
    { speaker: 'candidate' as const, text: ev.answer ?? `Answer for Q${ev.questionIndex + 1}.`, timestamp: ev.questionIndex * 60 + 30, questionIndex: ev.questionIndex },
  ])
}

function claudeFeedbackResponse(overrides: Partial<{
  overall_score: number
  answer_quality: number
  engagement_signals: number
  confidence_level: string
}> = {}) {
  return {
    text: JSON.stringify({
      overall_score: overrides.overall_score ?? 75,
      pass_probability: 'Medium',
      confidence_level: overrides.confidence_level ?? 'High',
      dimensions: {
        answer_quality: { score: overrides.answer_quality ?? 75, strengths: ['Clear structure'], weaknesses: [] },
        communication: { score: 75, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: {
          score: overrides.engagement_signals ?? 75,
          engagement_score: 72, confidence_trend: 'stable',
          energy_consistency: 0.7, composure_under_pressure: 70,
        },
      },
      red_flags: [],
      top_3_improvements: ['Quantify outcomes', 'Apply STAR more consistently', 'Drive a decision'],
    }),
    model: 't', provider: 't', inputTokens: 2000, outputTokens: 1000,
    usedFallback: false, truncated: false,
  }
}

function makeReq(evaluations: unknown[], extras: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      transcript: transcriptFor(evaluations as Array<{ questionIndex: number; question?: string; answer?: string }>),
      evaluations,
      speechMetrics: [],
      sessionId: '507f1f77bcf86cd799439011',
      ...extras,
    }),
  })
}

// ─── Scenarios ────────────────────────────────────────────────────

describe('G.15a scoring-V2 integration suite (all flags ON)', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockUpdatePracticeStats.mockReset()
    mockUpdatePracticeStats.mockResolvedValue({ updated: true, key: 'pm:screening' })
  })

  // ── Scenario 1 — complete strong session ──
  it('complete strong interview (10×85) produces a high spread overall_score without red_flags', async () => {
    // Claude awards 88 holistically. Formula would produce ~80. Blend
    // (0.6*88 + 0.4*80 in agreement zone since |Δ|=8) → 85.
    mockCompletion.mockResolvedValueOnce(
      claudeFeedbackResponse({ overall_score: 88, answer_quality: 82, engagement_signals: 85 }),
    )

    const evaluations = Array.from({ length: 10 }, (_, i) => evalRow(i, 85))
    const res = await POST(makeReq(evaluations, {
      plannedQuestionCount: 10,
      answeredCount: 10,
      endReason: 'normal',
    }))
    const json = await res.json()

    // Overall score is in the 80-90 band (not compressed to 65-75).
    expect(json.overall_score).toBeGreaterThanOrEqual(80)
    expect(json.overall_score).toBeLessThanOrEqual(92)
    // Confidence preserved as High — no completion penalty, no integrity issues.
    expect(json.confidence_level).toBe('High')
    // No G.10 red_flag (complete session).
    expect(json.red_flags.every((f: string) =>
      !f.includes('ended') && !f.includes('cut off'))).toBe(true)
    // G.14: server-side XP write fired.
    expect(mockUpdatePracticeStats).toHaveBeenCalledTimes(1)
    const xp = mockUpdatePracticeStats.mock.calls[0][0] as { score: number }
    expect(xp.score).toBe(json.overall_score)
  })

  // ── Scenario 2 — short-form guard refuses to score ──
  it('2 of 10 answers → short-form guard, no LLM call, no XP write', async () => {
    const evaluations = [evalRow(0, 85), evalRow(1, 90)] // cherry-pick
    const res = await POST(makeReq(evaluations, {
      plannedQuestionCount: 10,
      answeredCount: 2,
      endReason: 'user_ended',
    }))
    const json = await res.json()

    // Short-form path: overall_score=0, confidence=Low, explanatory red_flag.
    expect(json.overall_score).toBe(0)
    expect(json.confidence_level).toBe('Low')
    expect(json.red_flags.some((f: string) =>
      f.includes('3 answers are required'))).toBe(true)
    // LLM never called (saves $).
    expect(mockCompletion).not.toHaveBeenCalled()
    // XP write is gated on feedback.overall_score — short-form
    // returns 0 which triggers the gate; no XP increment for
    // cherry-picks.
    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
  })
})
