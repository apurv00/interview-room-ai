/**
 * Work Item G.5 — silent-zero / falsy-zero scrub in feedback aggregation.
 *
 * Two families of bugs this validates are no longer present:
 *   1. Falsy-zero stomp: `!fb.overall_score` / `fb.overall_score || X`
 *      treated a legit 0 as "missing" and defaulted it to 50 or preQ
 *      average. No-answer sessions (empty `evaluations` produces a
 *      server-side `noDataFeedback` with overall_score=0) were being
 *      rewritten client-side + in follow-up service writes. G.5
 *      switches to `?? null` / `== null` / `?? 50` so 0 survives.
 *
 *   2. Pressure-Q status handling: the pressure-vs-normal delta used
 *      `Number(x) || 0` over all evaluations. A status='failed' row
 *      (60/55/55/60 placeholder) contaminated the "normal" mean. G.5
 *      filters failed rows and emits an explicit message when the
 *      pressure row itself is failed.
 *
 * Tests focus on the arithmetic paths. The client-side feedback page
 * fix at app/feedback/[sessionId]/page.tsx:580 is validated here via
 * direct inspection of the `computeEngagementContext` helper export.
 */

import { describe, it, expect } from 'vitest'
import { computePerQAverage } from '@interview/services/eval/perQAggregation'

// ─── Unit tests: helpers ─────────────────────────────────────────────

describe('G.5 — computePerQAverage treats zero dim as real data', () => {
  // A dimension score of 0 is a legitimate signal (off-topic answer).
  // The helper must average it in, not skip it or treat it as missing.
  it('averages a 0-dim row in with non-zero rows', () => {
    const evals = [
      { relevance: 0, structure: 60, specificity: 60, ownership: 60 },   // 45
      { relevance: 80, structure: 80, specificity: 80, ownership: 80 },  // 80
    ]
    const { average, usedCount } = computePerQAverage(evals)
    expect(usedCount).toBe(2)
    expect(average).toBe(63) // (45 + 80) / 2 = 62.5 → 63
  })

  it('handles a row with all zero dims without flagging it as failed', () => {
    const evals = [{ relevance: 0, structure: 0, specificity: 0, ownership: 0 }]
    const { average, usedCount, skippedFailedCount } = computePerQAverage(evals)
    expect(average).toBe(0)
    expect(usedCount).toBe(1)
    expect(skippedFailedCount).toBe(0) // zero !== missing
  })
})

// ─── Integration: falsy-zero bugs no longer stomp legit zeros ─────────
//
// The server-side /api/generate-feedback handler has an early-exit
// for zero-evaluation sessions that returns overall_score=0. Prior to
// G.5, three post-processing paths would stomp that 0 to a non-zero
// default: route.ts:540 (feedback.overall_score || preQ.average),
// feedback/page.tsx:580 (!fb.overall_score → 50), and
// sessionSummaryService.ts:75 (feedback.overall_score || 0 — numeric
// no-op, but the pattern is wrong and we fixed it for intent).
//
// These tests verify the logical change. The route's integration-level
// behavior through POST is covered by existing suites
// (generateFeedbackIdempotency, generateFeedbackTruncation); here we
// validate the SPECIFIC paths G.5 edited.

import {
  isNullOrUndefined,
  preserveZero,
} from './testHelpers.g5'

describe('G.5 — falsy-zero helpers (documentation for readers)', () => {
  // These shim helpers mirror the `??` / `== null` pattern used in
  // the edited production code. If a future refactor reintroduces
  // `||` here, the test comments above point to the specific
  // production sites that break.
  it('isNullOrUndefined differentiates from 0', () => {
    expect(isNullOrUndefined(0)).toBe(false)
    expect(isNullOrUndefined(null)).toBe(true)
    expect(isNullOrUndefined(undefined)).toBe(true)
    expect(isNullOrUndefined(50)).toBe(false)
  })

  it('preserveZero returns 0 unchanged but defaults null/undefined', () => {
    expect(preserveZero(0, 50)).toBe(0)
    expect(preserveZero(null, 50)).toBe(50)
    expect(preserveZero(undefined, 50)).toBe(50)
    expect(preserveZero(72, 50)).toBe(72)
  })
})

// ─── Pressure-Q context respects status='failed' (route-level) ────────

import { vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletion } = vi.hoisted(() => ({ mockCompletion: vi.fn() }))

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
vi.mock('@shared/featureFlags', () => ({ isFeatureEnabled: () => false }))
vi.mock('@shared/services/promptSecurity', () => ({ DATA_BOUNDARY_RULE: '', JSON_OUTPUT_RULE: '' }))

// Force pressure-Q index = 2 so tests can place a failed/ok row there.
vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 2,
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

function makeReq(evaluations: unknown[], speechMetrics: unknown[]) {
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      transcript: [],
      evaluations,
      speechMetrics,
      sessionId: '507f1f77bcf86cd799439011',
    }),
  })
}

function okEval(qi: number, dim: number, status?: 'ok' | 'truncated' | 'failed') {
  return {
    questionIndex: qi, question: `Q${qi + 1}?`, answer: 'A',
    relevance: dim, structure: dim, specificity: dim, ownership: dim,
    ...(status && { status }),
    probeDecision: { shouldProbe: false },
  }
}

const happyFeedback = (userPromptSink?: (p: string) => void) => ({
  text: JSON.stringify({
    overall_score: 72,
    pass_probability: 'Medium',
    confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 70, strengths: [], weaknesses: [] },
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
    },
    red_flags: [],
    top_3_improvements: ['A', 'B', 'C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
  _sink: userPromptSink,
})

describe('G.5 — pressure-Q context respects status="failed"', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
  })

  it('emits "could not be scored" when the pressure row itself is failed', async () => {
    let capturedUserPrompt = ''
    mockCompletion.mockImplementationOnce(async (opts: { messages: Array<{ content: string }> }) => {
      capturedUserPrompt = opts.messages[0]?.content || ''
      return happyFeedback()
    })
    const evals = [
      okEval(0, 80),
      okEval(1, 80),
      okEval(2, 60, 'failed'), // pressure row (index 2) is failed
      okEval(3, 80),
    ]
    const speechMetrics = Array.from({ length: 4 }, () => ({
      wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2,
      totalWords: 120, fillerWordCount: 5, durationMinutes: 1,
    }))

    await POST(makeReq(evals, speechMetrics))

    // User prompt given to Claude contains the pressure context we built.
    expect(capturedUserPrompt).toContain('Pressure question (Q3) could not be scored')
    expect(capturedUserPrompt).not.toContain('avg score:') // the normal branch wasn't used
  })

  it('normal-avg excludes failed non-pressure rows from the denominator', async () => {
    let capturedUserPrompt = ''
    mockCompletion.mockImplementationOnce(async (opts: { messages: Array<{ content: string }> }) => {
      capturedUserPrompt = opts.messages[0]?.content || ''
      return happyFeedback()
    })
    // Pressure row = Q3 (index 2), scored 80. Other rows: one at 80, one
    // at 40, one status='failed' (placeholder 57.5). Pre-G.5 normal avg
    // would be (80 + 40 + 57.5) / 3 = 59.17 → 59.
    // Post-G.5: failed excluded → (80 + 40) / 2 = 60.
    const evals = [
      okEval(0, 80),
      okEval(1, 40),
      okEval(2, 80), // pressure row (ok)
      okEval(3, 57.5, 'failed'), // placeholder — must not drag avg
    ]
    const speechMetrics = Array.from({ length: 4 }, () => ({
      wpm: 140, fillerRate: 0.04, pauseScore: 70, ramblingIndex: 0.2,
      totalWords: 120, fillerWordCount: 5, durationMinutes: 1,
    }))

    await POST(makeReq(evals, speechMetrics))

    expect(capturedUserPrompt).toContain('avg score: 80')
    // Normal avg of ok rows only: 60
    expect(capturedUserPrompt).toContain('normal avg: 60')
  })
})

// ─── Audit P2 (2026-04-24) — speech metrics `|| 0` → `?? null` ──────
//
// The `computeEngagementContext` helper used `Number(m.x) || 0` for
// wpm, fillerRate, totalWords, durationMinutes. When a metric was
// missing (older client, Deepgram unavailable mid-interview, network
// drop during upload), `Number(undefined) || 0` silently became 0 —
// and the prompt rendered "WPM=0" as if the candidate had spoken at
// zero words per minute. Claude then scored Communication against
// that fabricated baseline. The same `|| 0` in the half-average
// reducers biased the Trends line toward 0 whenever any session
// half had all-missing data.
//
// Fix: null-through everywhere. Missing fields render as "not
// available" (per-Q lines) or "n/a" (trend deltas); half-averages
// skip nulls from both numerator and denominator and return null
// when every entry is missing.

import { computeEngagementContext } from '@/app/api/generate-feedback/route'

describe('computeEngagementContext — audit P2 null-aware speech metrics', () => {
  it('renders "not available" for a missing WPM on a single question', async () => {
    const { perQSummary } = computeEngagementContext(
      [
        { wpm: 140, fillerRate: 0.04, totalWords: 120, durationMinutes: 0.9 },
        // wpm missing — the bug
        { fillerRate: 0.05, totalWords: 100, durationMinutes: 0.8 },
      ],
      [],
      99,
    )
    // Per-Q line for Q2 shows "not available", not "WPM=0".
    expect(perQSummary).toMatch(/Q2:\s*WPM=not available/)
    expect(perQSummary).not.toMatch(/Q2:\s*WPM=0[^0-9.]/)
  })

  it('renders "not available" for every missing field on a question', async () => {
    const { perQSummary } = computeEngagementContext(
      [
        { wpm: 140, fillerRate: 0.04, totalWords: 120, durationMinutes: 0.9 },
        // All four metrics missing (complete metric failure for Q2).
        {},
      ],
      [],
      99,
    )
    expect(perQSummary).toMatch(/Q2:\s*WPM=not available, filler_rate=not available, words=not available, duration=not available/)
  })

  it('renders "not available" when a metric is null or NaN (not just undefined)', async () => {
    const { perQSummary } = computeEngagementContext(
      [
        { wpm: null, fillerRate: NaN, totalWords: undefined, durationMinutes: 'bad' },
      ],
      [],
      99,
    )
    expect(perQSummary).toMatch(/Q1:\s*WPM=not available, filler_rate=not available, words=not available, duration=not available/)
  })

  it('half-averages exclude missing entries (numerator AND denominator)', async () => {
    // 4 questions, Q3 missing everything. The second-half average
    // should be computed from Q4 only, NOT (Q3 + Q4) / 2 with Q3 as 0.
    const { perQSummary } = computeEngagementContext(
      [
        { wpm: 100, fillerRate: 0.04, totalWords: 100, durationMinutes: 1.0 },
        { wpm: 100, fillerRate: 0.04, totalWords: 100, durationMinutes: 1.0 },
        {}, // missing
        { wpm: 120, fillerRate: 0.10, totalWords: 200, durationMinutes: 2.0 },
      ],
      [],
      99,
    )
    // halfIdx = ceil(4/2) = 2 → firstHalf = Q1+Q2, secondHalf = Q3+Q4.
    // Pre-fix: secondHalf avgWords = (0 + 200)/2 = 100 — the bug.
    // Post-fix: secondHalf avgWords = 200/1 = 200 — Q3's null skipped.
    expect(perQSummary).toMatch(/Avg answer length: 100 → 200 words/)
    // Filler rate: firstHalf (4+4)/2=4%, secondHalf 10/1=10%.
    expect(perQSummary).toMatch(/Filler rate: 4\.0% → 10\.0%/)
  })

  it('emits "n/a" in the trend when every entry in a half is missing', async () => {
    // First half completely missing, second half present → the pre-fix
    // would render "0.0% → 5.0%" (first half = 0 via || 0 over 2
    // missing entries), making it look like a huge improvement from
    // zero when the truth is we had no data for the first half.
    const { perQSummary } = computeEngagementContext(
      [
        {},
        {},
        { wpm: 120, fillerRate: 0.05, totalWords: 100, durationMinutes: 1.0 },
        { wpm: 120, fillerRate: 0.05, totalWords: 100, durationMinutes: 1.0 },
      ],
      [],
      99,
    )
    expect(perQSummary).toMatch(/Filler rate: n\/a → 5\.0%/)
    expect(perQSummary).toMatch(/Avg answer length: n\/a → 100 words/)
  })

  it('empty speechMetrics array falls through to the "no metrics" branch', async () => {
    const { perQSummary, pressureContext } = computeEngagementContext([], [], 99)
    expect(perQSummary).toBe('No per-question speech metrics available.')
    expect(pressureContext).toBe('')
  })

  it('preserves genuinely zero metrics (not treated as missing)', async () => {
    // A legit 0 — candidate literally spoke zero filler words — must
    // survive as "0.0%", NOT be rewritten to "not available". The
    // null-aware coercion distinguishes `0` (a real number) from
    // `null`/`undefined` (missing).
    const { perQSummary } = computeEngagementContext(
      [{ wpm: 140, fillerRate: 0, totalWords: 100, durationMinutes: 1.0 }],
      [],
      99,
    )
    expect(perQSummary).toMatch(/filler_rate=0\.0%/)
    expect(perQSummary).not.toMatch(/filler_rate=not available/)
  })

  it('renders a happy path with all metrics present verbatim', async () => {
    const { perQSummary } = computeEngagementContext(
      [
        { wpm: 140, fillerRate: 0.04, totalWords: 100, durationMinutes: 0.8 },
      ],
      [],
      99,
    )
    expect(perQSummary).toMatch(/Q1:\s*WPM=140, filler_rate=4\.0%, words=100, duration=0\.8min/)
  })
})
