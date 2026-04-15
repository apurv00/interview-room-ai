/**
 * Work Item G.12 — timer-truncated answers.
 *
 * Validates the three-layer wiring:
 *   1. /api/evaluate-answer: when `wasTruncatedByTimer=true` in the
 *      request body, the user prompt gains a "do not penalize
 *      incompleteness" instruction AND the returned evaluation
 *      carries `flags: [..., 'truncated_by_timer']`.
 *   2. /api/evaluate-answer: when the flag is absent/false, the
 *      prompt is unchanged and the flag is NOT added to the
 *      evaluation.
 *   3. /api/generate-feedback: evaluations whose `flags` contains
 *      'truncated_by_timer' surface as a single user-visible
 *      red_flag that explains the non-penalty.
 *
 * Single mock set at module scope — both evaluate-answer (via
 * completionStream) and generate-feedback (via completion) are
 * served by the same vi.fn so we don't double-register the
 * modelRouter mock (the second registration would silently
 * override the first and break cross-describe tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockAiFn } = vi.hoisted(() => ({ mockAiFn: vi.fn() }))

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
      user: { id: 't1', role: 'candidate', plan: 'free', email: 't@e.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockAiFn,
  completionStream: mockAiFn,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/feedbackLock', () => ({
  acquireFeedbackLock: vi.fn().mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true }),
  releaseFeedbackLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/scoreTelemetry', () => ({
  recordScoreDelta: vi.fn().mockResolvedValue(null),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewDepth: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
  InterviewSession: { findByIdAndUpdate: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DEPTHS: [{
    slug: 'screening',
    evaluationCriteria: '',
    scoringDimensions: [
      { name: 'relevance', label: 'Relevance', weight: 0.25 },
      { name: 'structure', label: 'STAR', weight: 0.25 },
      { name: 'specificity', label: 'Specificity', weight: 0.25 },
      { name: 'ownership', label: 'Ownership', weight: 0.25 },
    ],
  }],
}))

vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'PM',
  getPressureQuestionIndex: () => 99,
  getQuestionCount: (d: number) => d === 30 ? 16 : 11,
}))

vi.mock('@interview/config/speechMetrics', () => ({
  aggregateMetrics: () => ({ wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2 }),
  communicationScore: () => 72,
}))

vi.mock('@interview/services/core/skillLoader', () => ({ getSkillSections: vi.fn().mockResolvedValue(null) }))
vi.mock('@interview/config/companyProfiles', () => ({ findCompanyProfile: () => null }))
vi.mock('@interview/services/eval/evaluationEngine', () => ({
  getScoringDimensions: vi.fn().mockResolvedValue([]),
  buildRubricPromptSection: () => '',
  evaluateSession: vi.fn().mockResolvedValue({}),
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

import { POST as EVALUATE_ANSWER_POST } from '@/app/api/evaluate-answer/route'
import { POST as GENERATE_FEEDBACK_POST } from '@/app/api/generate-feedback/route'

const validEvalScores = JSON.stringify({
  relevance: 70, structure: 65, specificity: 60, ownership: 70,
  shouldProbe: false, probeType: null, probeTarget: null, isPivot: false,
})

const happyFeedback = {
  text: JSON.stringify({
    overall_score: 70, pass_probability: 'Medium', confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 70, strengths: [], weaknesses: [] },
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 70, engagement_score: 70, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
    },
    red_flags: [], top_3_improvements: ['A', 'B', 'C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
}

// ─── /api/evaluate-answer ──────────────────────────────────────────────────

describe('POST /api/evaluate-answer — G.12 wasTruncatedByTimer wiring', () => {
  beforeEach(() => { mockAiFn.mockReset() })

  function makeReq(wasTruncatedByTimer?: boolean) {
    const body: Record<string, unknown> = {
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      question: 'Tell me about a time you resolved a conflict.',
      answer: 'I led a 3-person team through a blocked release.',
      questionIndex: 0,
      sessionId: '507f1f77bcf86cd799439011',
    }
    if (wasTruncatedByTimer !== undefined) body.wasTruncatedByTimer = wasTruncatedByTimer
    return new NextRequest('http://localhost:3000/api/evaluate-answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  }

  async function runCapture(wasTruncatedByTimer?: boolean) {
    let capturedUserPrompt = ''
    mockAiFn.mockImplementationOnce(async (opts: { messages: Array<{ content: string }> }) => {
      capturedUserPrompt = opts.messages[0]?.content || ''
      return {
        text: validEvalScores, model: 't', provider: 't',
        inputTokens: 100, outputTokens: 80, usedFallback: false, truncated: false,
      }
    })
    const res = await EVALUATE_ANSWER_POST(makeReq(wasTruncatedByTimer))
    const json = await res.json()
    return { json, capturedUserPrompt }
  }

  it('flag=true → user prompt includes the "do not penalize" note', async () => {
    const { capturedUserPrompt } = await runCapture(true)
    expect(capturedUserPrompt).toContain('the interview timer expired')
    expect(capturedUserPrompt).toMatch(/do NOT penalize/i)
  })

  it('flag=false → user prompt does NOT include the truncation note', async () => {
    const { capturedUserPrompt } = await runCapture(false)
    expect(capturedUserPrompt.length).toBeGreaterThan(0) // sanity — prompt exists
    expect(capturedUserPrompt).not.toContain('timer expired')
    expect(capturedUserPrompt).not.toMatch(/do NOT penalize/i)
  })

  it('flag absent → user prompt does NOT include the truncation note', async () => {
    const { capturedUserPrompt } = await runCapture(undefined)
    expect(capturedUserPrompt.length).toBeGreaterThan(0)
    expect(capturedUserPrompt).not.toContain('timer expired')
  })

  it('flag=true → evaluation.flags contains "truncated_by_timer"', async () => {
    const { json } = await runCapture(true)
    expect(Array.isArray(json.flags)).toBe(true)
    expect(json.flags).toContain('truncated_by_timer')
  })

  it('flag=false → evaluation.flags does not contain "truncated_by_timer"', async () => {
    const { json } = await runCapture(false)
    const flags = json.flags ?? []
    expect(flags).not.toContain('truncated_by_timer')
  })
})

// ─── /api/generate-feedback ────────────────────────────────────────────────

describe('POST /api/generate-feedback — G.12 red_flag surfaces truncated_by_timer', () => {
  beforeEach(() => { mockAiFn.mockReset() })

  function evalWithFlag(qi: number, flag?: string) {
    return {
      questionIndex: qi, question: `Q${qi + 1}?`, answer: 'A',
      relevance: 70, structure: 65, specificity: 60, ownership: 70,
      ...(flag && { flags: [flag] }),
      probeDecision: { shouldProbe: false },
    }
  }

  function makeReq(evaluations: unknown[]) {
    return new NextRequest('http://localhost:3000/api/generate-feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
        transcript: [], evaluations, speechMetrics: [],
        sessionId: '507f1f77bcf86cd799439011',
      }),
    })
  }

  it('adds a red_flag when any eval has flags=["truncated_by_timer"]', async () => {
    mockAiFn.mockResolvedValueOnce(happyFeedback)
    const evals = [
      evalWithFlag(0), evalWithFlag(1, 'truncated_by_timer'), evalWithFlag(2),
    ]
    const res = await GENERATE_FEEDBACK_POST(makeReq(evals))
    const json = await res.json()
    expect(json.red_flags.some((f: string) =>
      f.includes('cut off when the timer expired'))).toBe(true)
  })

  it('reports the correct count when multiple answers were timer-cut', async () => {
    mockAiFn.mockResolvedValueOnce(happyFeedback)
    const evals = [
      evalWithFlag(0, 'truncated_by_timer'),
      evalWithFlag(1, 'truncated_by_timer'),
      evalWithFlag(2),
    ]
    const res = await GENERATE_FEEDBACK_POST(makeReq(evals))
    const json = await res.json()
    const flag = json.red_flags.find((f: string) => f.includes('timer expired'))
    expect(flag).toContain('2 answers')
  })

  it('singular grammar for one answer', async () => {
    mockAiFn.mockResolvedValueOnce(happyFeedback)
    const evals = [evalWithFlag(0, 'truncated_by_timer'), evalWithFlag(1)]
    const res = await GENERATE_FEEDBACK_POST(makeReq(evals))
    const json = await res.json()
    const flag = json.red_flags.find((f: string) => f.includes('timer expired'))
    expect(flag).toContain('1 answer was')
  })

  it('no red_flag added when no evaluations have the marker', async () => {
    mockAiFn.mockResolvedValueOnce(happyFeedback)
    const evals = [evalWithFlag(0), evalWithFlag(1)]
    const res = await GENERATE_FEEDBACK_POST(makeReq(evals))
    const json = await res.json()
    expect(json.red_flags.every((f: string) => !f.includes('timer expired'))).toBe(true)
  })
})
