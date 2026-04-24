/**
 * P0 fix (2026-04-22 session 69e8f4eb): pins the `degraded: true` flag
 * contract on /api/generate-feedback.
 *
 * Before PR #311: when the Claude `completion` call threw, the outer
 * catch persisted a fallback with a synthesised `overall_score` (e.g.
 * 30), hardcoded generic `top_3_improvements` ("Use the STAR
 * framework..."), and `confidence_level: 'Low'`. The UI rendered it
 * indistinguishably from a real success.
 *
 * PR #311 added `degraded: true` to the in-flight response so the page
 * could show a banner. After-merge audit (gitNexus impact analysis on
 * `FeedbackData` + file-scoped reads of `feedback.overall_score`) found
 * ~10 downstream reader sites that did NOT gate on the flag — dashboard
 * "last score" tile, history pass-badge, score-trend chart, recruiter
 * scorecard, pathway planner prompt, session summary prompt, GDPR data
 * export, peer-comparison `$avg` aggregation, print/PDF builder,
 * shareable-link renderer. Persisting the synthetic payload kept
 * leaking the 30/100 + STAR advice into all of those surfaces, and
 * corrupted the peer-cohort baseline for other users via `$avg`.
 *
 * Follow-up (option B): the outer-catch fallback is NEVER persisted
 * to Mongo. The in-flight response still carries `degraded: true` for
 * the page-level banner, but `InterviewSession.feedback` stays
 * `undefined` after a failure — which all downstream readers already
 * handle as "not generated yet".
 *
 * This test pins five invariants:
 *
 *   1. Outer-catch fallback (Claude threw) → response has `degraded: true`
 *   2. Outer-catch fallback is NOT persisted — no `findByIdAndUpdate`
 *      call carries a `feedback` field.
 *   3. Legitimate low-signal paths (no evals, short-form <3) → NO
 *      `degraded` flag (those 0 scores are real, red_flags explains them)
 *   4. Normal successful path (Claude returned valid JSON) → NO
 *      `degraded` flag
 *   5. Cache-bypass on legacy degraded rows (Codex P1 on #311) still
 *      fires for production sessions persisted before the no-persist
 *      change.
 *
 * If a future refactor re-introduces persistence of the synthetic
 * fallback, test #2 fails and the downstream leaks come back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockCompletion, mockIsFeatureEnabled,
  mockGenerateSessionSummary, mockGeneratePathwayPlan, mockUpdatePracticeStats,
  mockUpdateCompetencyState, mockUpdateMasteryBatch, mockAdvanceUniversalPlan,
} = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
  // Hoisted so the inner-fallback side-effect-gating tests can assert
  // these are NOT called when feedback.degraded is true. The full set
  // (feedback-dependent + non-idempotent feedback-independent) is
  // covered because Codex P1 on PR #317 flagged that advanceUniversalPlan
  // (`pathwayPlanner.ts:541` — increments sessionsCompleted),
  // updateMasteryBatch (streak counters), and updateCompetencyState
  // (`competencyService.ts:90` — appends to scoreHistory) would
  // otherwise double-fire across a degraded → retry sequence.
  mockGenerateSessionSummary: vi.fn().mockResolvedValue(undefined),
  mockGeneratePathwayPlan: vi.fn().mockResolvedValue(undefined),
  mockUpdatePracticeStats: vi.fn().mockResolvedValue(undefined),
  mockUpdateCompetencyState: vi.fn().mockResolvedValue(undefined),
  mockUpdateMasteryBatch: vi.fn().mockResolvedValue([]),
  mockAdvanceUniversalPlan: vi.fn().mockResolvedValue(null),
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
/**
 * F-4 preflight cache-hit check in route.ts:292-318 queries
 * InterviewSession.findOne(...).select('feedback').lean(). The cache-
 * bypass test (Codex P1 on PR #311) needs this mock to return a
 * degraded feedback payload so we can confirm the route skips the
 * cached hit and regenerates. Default: return no cached feedback
 * (happy path).
 */
const { mockSessionFindOne, mockFindByIdAndUpdate } = vi.hoisted(() => ({
  mockSessionFindOne: vi.fn(),
  mockFindByIdAndUpdate: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewSession: {
    findByIdAndUpdate: mockFindByIdAndUpdate,
    findOne: (query: unknown) => ({
      select: () => ({
        lean: () => Promise.resolve(mockSessionFindOne(query)),
      }),
    }),
  },
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
  updateCompetencyState: mockUpdateCompetencyState,
  updateWeaknessClusters: vi.fn().mockResolvedValue(undefined),
  getUserCompetencySummary: vi.fn().mockResolvedValue(null),
}))
vi.mock('@learn/services/masteryTracker', () => ({
  updateMasteryBatch: mockUpdateMasteryBatch,
}))
vi.mock('@learn/services/pathwayBadgeWiring', () => ({
  registerPathwayBadgeWiring: vi.fn(),
}))
vi.mock('@learn/services/sessionSummaryService', () => ({
  generateSessionSummary: mockGenerateSessionSummary,
  buildHistorySummary: vi.fn().mockResolvedValue(null),
}))
vi.mock('@learn/services/pathwayPlanner', () => ({
  generatePathwayPlan: mockGeneratePathwayPlan,
  // Hoisted to assert the degraded path does NOT call this.
  // `advanceUniversalPlan` is non-idempotent (pathwayPlanner.ts:541
  // increments `sessionsCompleted`), so if the degraded → retry
  // sequence fires it twice, the same interview is counted twice.
  advanceUniversalPlan: mockAdvanceUniversalPlan,
}))
vi.mock('@learn/services/practiceStatsService', () => ({
  updatePracticeStats: mockUpdatePracticeStats,
  deriveStrongWeakDimensions: () => ({ strongDimensions: [], weakDimensions: [] }),
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

const healthyClaudeResponse = {
  text: JSON.stringify({
    overall_score: 80,
    pass_probability: 'High',
    confidence_level: 'High',
    dimensions: {
      answer_quality: { score: 80, strengths: ['clarity'], weaknesses: [] },
      communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
      engagement_signals: { score: 80, engagement_score: 78, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 75 },
    },
    red_flags: [],
    top_3_improvements: ['Specific to the session A', 'Specific B', 'Specific C'],
  }),
  model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
}

describe('POST /api/generate-feedback — degraded flag contract', () => {
  beforeEach(() => {
    mockCompletion.mockReset()
    mockIsFeatureEnabled.mockReset()
    // PR #321: `pathway_planner` is preflighted now. Returning true
    // for that flag keeps the pathway side-effect scheduled so it
    // participates in the findByIdAndUpdate invariants this suite
    // checks (persist is now in the sideEffects[] tracking array).
    // Non-preflighted flags are irrelevant to these tests.
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag === 'pathway_planner')
    mockSessionFindOne.mockReset()
    mockFindByIdAndUpdate.mockReset()
    mockFindByIdAndUpdate.mockResolvedValue(undefined)
    mockGenerateSessionSummary.mockClear()
    mockGeneratePathwayPlan.mockClear()
    mockUpdatePracticeStats.mockClear()
    mockUpdateCompetencyState.mockClear()
    mockUpdateMasteryBatch.mockClear()
    mockAdvanceUniversalPlan.mockClear()
    // Default: no persisted feedback → preflight cache is a miss,
    // route proceeds to LLM call.
    mockSessionFindOne.mockResolvedValue(null)
  })

  it('sets degraded=true on the outer-catch fallback when Claude throws', async () => {
    // Simulate the exact failure mode from the 2026-04-22 session
    // (LLM/timeout error). Outer catch builds the synthetic fallback.
    mockCompletion.mockRejectedValueOnce(new Error('Claude API timeout'))

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    expect(json.degraded).toBe(true)
    // Existing fields must still be populated — downstream consumers
    // (InterviewSession.feedback in Mongo, practiceStats) rely on them
    // being present. The flag is additive.
    expect(typeof json.overall_score).toBe('number')
    expect(json.confidence_level).toBe('Low')
    expect(Array.isArray(json.top_3_improvements)).toBe(true)
    // Marker copy that appears in the in-flight response (not persisted).
    expect(json.dimensions.answer_quality.weaknesses).toContain(
      'Feedback generation encountered an error — scores are approximate',
    )
  })

  it('outer-catch fallback is NOT persisted to InterviewSession.feedback', async () => {
    // Option-B contract (2026-04-22 follow-up): the synthetic fallback
    // may only be returned in the in-flight response — it must never
    // land in Mongo. Audit trail for WHY this invariant matters lives
    // in the header docblock.
    //
    // Invariant: the ONLY InterviewSession.findByIdAndUpdate calls
    // from the outer-catch path are allowed to update status /
    // completedAt / telemetry-adjacent fields, but NONE of them may
    // carry a `feedback` key. The safest assertion is "no
    // findByIdAndUpdate was called carrying a `feedback` key at all",
    // because a future refactor that re-introduces the persistence
    // will either (a) call findByIdAndUpdate with a feedback field,
    // or (b) add a different writer — both of which are caught here
    // if we also assert no writer is called with a feedback key.
    mockCompletion.mockRejectedValueOnce(new Error('Claude API timeout'))

    await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))

    const callsCarryingFeedback = mockFindByIdAndUpdate.mock.calls.filter(([, update]) => {
      return update && typeof update === 'object' && 'feedback' in update
    })
    expect(callsCarryingFeedback).toHaveLength(0)
  })

  it('does NOT set degraded on the no-data path (0 evaluations)', async () => {
    // The "no answers were provided" path returns a legitimate 0 score
    // with explanatory red_flags. This isn't a degraded run — it's an
    // honest reflection that nothing was scorable. UI should NOT show
    // a "feedback retry recommended" banner here.
    const res = await POST(makeReq({
      evals: [],
      plannedQuestionCount: 6,
      answeredCount: 0,
      endReason: 'user_ended',
    }))
    const json = await res.json()

    expect(json.degraded).toBeUndefined()
    expect(json.overall_score).toBe(0)
    expect(json.red_flags).toEqual(expect.arrayContaining([expect.stringMatching(/without any responses/i)]))
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('does NOT set degraded on the short-form path (<3 evaluations)', async () => {
    // Similar to no-data: <3 answers is a policy-driven refusal to
    // score, not an LLM failure. The 0 score is intentional and the
    // red_flag copy explains it. No retry banner needed.
    const res = await POST(makeReq({
      evals: evals(2),
      plannedQuestionCount: 10,
      answeredCount: 2,
      endReason: 'user_ended',
    }))
    const json = await res.json()

    expect(json.degraded).toBeUndefined()
    expect(json.overall_score).toBe(0)
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  // ── Codex P1 follow-up on PR #311 — retry must bypass degraded cache ──
  //
  // The UI's "Retry feedback" button re-POSTs to this route with the same
  // sessionId. Before this fix, the F-4 preflight cache-hit check at
  // route.ts:301 returned the persisted degraded payload immediately,
  // making retry a no-op. Contract: when persisted feedback has
  // `degraded: true`, the cache check is bypassed and the LLM is called
  // again. The feedbackLock (acquired upstream) prevents concurrent
  // regeneration races.

  it('retry BYPASSES cache when persisted feedback has degraded:true (Codex P1 on #311)', async () => {
    // Simulate the retry scenario: session already has a degraded
    // fallback written from a previous failed run. User clicks Retry.
    const previousDegraded = {
      overall_score: 30,
      pass_probability: 'Low',
      confidence_level: 'Low',
      dimensions: {
        answer_quality: { score: 0, strengths: [], weaknesses: ['Feedback generation encountered an error — scores are approximate'] },
        communication: { score: 99, wpm: 87, filler_rate: 0.009, pause_score: 53, rambling_index: 0 },
        engagement_signals: { score: 0, engagement_score: 0, confidence_trend: 'stable', energy_consistency: 0.5, composure_under_pressure: 0 },
      },
      red_flags: [],
      top_3_improvements: ['Use the STAR framework...', 'Include specific metrics...', 'Reduce filler words...'],
      degraded: true,
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousDegraded })
    // Retry should reach the LLM and succeed this time.
    mockCompletion.mockResolvedValueOnce(healthyClaudeResponse)

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    // The cache was bypassed — LLM was called.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    // Fresh LLM output replaced the degraded payload.
    expect(json.overall_score).toBeGreaterThan(0)
    expect(json.degraded).toBeUndefined()
    // The hardcoded fallback copy must NOT appear in the fresh response.
    expect(json.top_3_improvements).not.toContain(
      'Use the STAR framework explicitly for every behavioral question',
    )
  })

  it('still USES cache when persisted feedback is NOT degraded (happy-path regression guard)', async () => {
    // Regression guard for the F-4 concurrent-writer optimisation.
    // When a real (non-degraded) feedback is already persisted, the
    // preflight short-circuit must still return it without re-calling
    // the LLM — no unnecessary cost.
    const previousHealthy = {
      overall_score: 75,
      pass_probability: 'High',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 75, strengths: [], weaknesses: [] },
        communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: { score: 75, engagement_score: 70, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 70 },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
      // degraded intentionally absent
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousHealthy })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    // LLM was NOT called — cache short-circuit preserved.
    expect(mockCompletion).not.toHaveBeenCalled()
    // Returned payload is the cached one verbatim.
    expect(json.overall_score).toBe(75)
  })

  // ── Codex P2 follow-up on PR #311 — normalise degraded to boolean ──
  //
  // The UI's banner renders on `{feedback.degraded && ...}` (truthy
  // check). The server-side cache-bypass MUST use the same semantics,
  // otherwise a non-boolean truthy value ever surviving persistence
  // (schema drift, legacy payloads) produces a split-brain: UI shows
  // the banner but server returns cached payload → retry becomes a
  // no-op. These tests pin the truthy contract.

  it('bypasses cache on truthy non-boolean degraded values (string "true")', async () => {
    // Defensive: a payload where degraded survived persistence as a
    // string must still trigger cache bypass. Without Boolean()
    // coercion the strict `=== true` check would miss this and the
    // user would be stuck on the degraded payload.
    const previousWithStringDegraded = {
      overall_score: 30,
      pass_probability: 'Low',
      confidence_level: 'Low',
      dimensions: {
        answer_quality: { score: 0, strengths: [], weaknesses: ['err'] },
        communication: { score: 99, wpm: 87, filler_rate: 0.009, pause_score: 53, rambling_index: 0 },
        engagement_signals: { score: 0, engagement_score: 0, confidence_trend: 'stable', energy_consistency: 0.5, composure_under_pressure: 0 },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
      // Non-boolean truthy — e.g. schema drift or JSON coercion
      degraded: 'true' as unknown as boolean,
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousWithStringDegraded })
    mockCompletion.mockResolvedValueOnce(healthyClaudeResponse)

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    // Cache bypassed → LLM was called.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    // Fresh response, not the string-degraded cached one.
    expect(json.overall_score).toBeGreaterThan(30)
  })

  it('bypasses cache on truthy number degraded (1)', async () => {
    const previousWithNumericDegraded = {
      overall_score: 30,
      pass_probability: 'Low',
      confidence_level: 'Low',
      dimensions: {
        answer_quality: { score: 0, strengths: [], weaknesses: ['err'] },
        communication: { score: 99, wpm: 87, filler_rate: 0.009, pause_score: 53, rambling_index: 0 },
        engagement_signals: { score: 0, engagement_score: 0, confidence_trend: 'stable', energy_consistency: 0.5, composure_under_pressure: 0 },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
      degraded: 1 as unknown as boolean,
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousWithNumericDegraded })
    mockCompletion.mockResolvedValueOnce(healthyClaudeResponse)

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))

    expect(mockCompletion).toHaveBeenCalledTimes(1)
  })

  it('still USES cache when degraded is a falsy non-boolean (0, "", null)', async () => {
    // Symmetric test: falsy values (0, empty string, null) must be
    // treated as "not degraded" — same as `false` or `undefined` —
    // to match the UI's truthy gate. Prevents unnecessary LLM
    // regeneration on malformed-but-healthy sessions.
    const previousWithNullDegraded = {
      overall_score: 75,
      pass_probability: 'High',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 75, strengths: [], weaknesses: [] },
        communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
        engagement_signals: { score: 75, engagement_score: 70, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 70 },
      },
      red_flags: [],
      top_3_improvements: ['A', 'B', 'C'],
      degraded: null as unknown as boolean,
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousWithNullDegraded })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    // LLM NOT called — null is falsy, cache short-circuit still fires.
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(json.overall_score).toBe(75)
  })

  it('treats degraded:false (explicitly set) the same as a cached healthy feedback', async () => {
    // Defensive test for payloads that explicitly set degraded:false.
    // The check in the route is `!== true`, so false is treated as
    // "valid" — which is correct and matches how undefined is handled.
    const previousWithExplicitFalse = {
      overall_score: 60,
      pass_probability: 'Medium',
      confidence_level: 'Medium',
      dimensions: {
        answer_quality: { score: 60, strengths: [], weaknesses: [] },
        communication: { score: 60, wpm: 120, filler_rate: 0.05, pause_score: 60, rambling_index: 0.1 },
        engagement_signals: { score: 60, engagement_score: 60, confidence_trend: 'stable', energy_consistency: 0.6, composure_under_pressure: 60 },
      },
      red_flags: [],
      top_3_improvements: ['X', 'Y', 'Z'],
      degraded: false,
    }
    mockSessionFindOne.mockResolvedValueOnce({ feedback: previousWithExplicitFalse })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    expect(mockCompletion).not.toHaveBeenCalled()
    expect(json.overall_score).toBe(60)
  })

  // ── Inner-fallback contract — partial Claude JSON (audit 2026-04-24) ──
  //
  // Distinct from the outer-catch (Claude threw an exception) tested above.
  // Here Claude returns a 200 response, JSON is parseable, but required
  // fields (`overall_score` or `dimensions`) are missing — the common
  // max_tokens-truncation shape. The inner fallback at route.ts:685-708
  // used to silently patch missing fields with literal constants
  // (composure_under_pressure: 65, energy_consistency: 0.7), set
  // confidence_level='Medium', and NOT set the degraded flag — so every
  // downstream reader (dashboard last-score tile, history pass-badge,
  // peer-comparison $avg, GDPR export) rendered the fabricated numbers
  // as real feedback.
  //
  // Contract: when the parsed response is missing `overall_score` or
  // `dimensions`, the response MUST carry `degraded: true` +
  // `confidence_level: 'Low'` + a red_flag mentioning "approximate", so
  // UI gates the banner the same way it does for outer-catch failures.

  it('sets degraded=true on inner fallback when Claude returns missing overall_score', async () => {
    mockCompletion.mockResolvedValueOnce({
      // Simulates a truncated Claude response — JSON parses, Zod passthrough
      // validates, but the keystone field is absent.
      text: JSON.stringify({
        pass_probability: 'Medium',
        top_3_improvements: ['A', 'B', 'C'],
      }),
      model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
    })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    expect(json.degraded).toBe(true)
    expect(json.confidence_level).toBe('Low')
    expect(Array.isArray(json.red_flags)).toBe(true)
    expect(json.red_flags.some((f: string) => f.includes('approximate'))).toBe(true)

    // Blast-radius gate contract (widened after Codex P1 on #317):
    // when the inner fallback fires, NONE of the side effects in the
    // `:968` block may run. The full set includes the feedback-
    // dependent trio (persist, practiceStats, sessionSummary,
    // pathwayPlan) AND the non-idempotent feedback-INDEPENDENT writes
    // (competency, mastery, universal-plan), because the latter would
    // double-fire across the degraded → retry sequence and corrupt
    // user progression (advanceUniversalPlan increments sessionsCompleted
    // on every call; updateCompetencyState appends to scoreHistory per
    // session; updateMasteryBatch bumps streak counters).
    const persistCalls = mockFindByIdAndUpdate.mock.calls.filter(([, update]) => {
      return update && typeof update === 'object' && 'feedback' in update
    })
    expect(persistCalls).toHaveLength(0)
    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
    expect(mockGenerateSessionSummary).not.toHaveBeenCalled()
    expect(mockGeneratePathwayPlan).not.toHaveBeenCalled()
    expect(mockUpdateCompetencyState).not.toHaveBeenCalled()
    expect(mockUpdateMasteryBatch).not.toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).not.toHaveBeenCalled()
  })

  it('sets degraded=true on inner fallback when Claude returns missing dimensions', async () => {
    mockCompletion.mockResolvedValueOnce({
      // Another truncation shape — overall_score present but the whole
      // `dimensions` block was cut off.
      text: JSON.stringify({
        overall_score: 72,
        pass_probability: 'Medium',
      }),
      model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
    })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    expect(json.degraded).toBe(true)
    expect(json.confidence_level).toBe('Low')
    expect(json.red_flags.some((f: string) => f.includes('approximate'))).toBe(true)
    // The fabricated dimensions are still present (the user still sees a
    // full-shaped report), but the flags above tell the UI to gate it.
    expect(json.dimensions).toBeDefined()
    expect(json.dimensions.engagement_signals).toBeDefined()

    // Same widened gate contract as the missing-overall_score test:
    // case 2 also ships literal-fabricated engagement_signals
    // (composure_under_pressure: 65, energy_consistency: 0.7,
    // confidence_trend: 'stable') — skip every non-idempotent side
    // effect until retry.
    expect(mockUpdatePracticeStats).not.toHaveBeenCalled()
    expect(mockGenerateSessionSummary).not.toHaveBeenCalled()
    expect(mockGeneratePathwayPlan).not.toHaveBeenCalled()
    expect(mockUpdateCompetencyState).not.toHaveBeenCalled()
    expect(mockUpdateMasteryBatch).not.toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).not.toHaveBeenCalled()
  })

  it('does NOT duplicate the approximate red_flag when Claude already included one', async () => {
    // Defensive: if Claude's partial output already contained a red_flag
    // matching /approximate/, we must not push a second one — the red_flag
    // list appears verbatim in the UI.
    mockCompletion.mockResolvedValueOnce({
      text: JSON.stringify({
        // overall_score missing — inner fallback fires
        pass_probability: 'Medium',
        red_flags: ['AI feedback response was incomplete — some dimension scores are approximate.'],
      }),
      model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
    })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    const approximateFlags = json.red_flags.filter((f: string) => f.includes('approximate'))
    expect(approximateFlags).toHaveLength(1)
  })

  it('does NOT set degraded on a normal successful Claude response', async () => {
    // The happy path. Flag must only appear on actual failures.
    // Regression guard — if someone accidentally sets degraded=true
    // in the healthy-path response builder, every real session would
    // show the "feedback retry recommended" banner.
    mockCompletion.mockResolvedValueOnce(healthyClaudeResponse)

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    expect(json.degraded).toBeUndefined()
    expect(json.overall_score).toBeGreaterThan(0)
    // The Claude-provided top_3 should flow through verbatim — NOT the
    // hardcoded STAR/metrics/filler defaults the fallback uses.
    expect(json.top_3_improvements).not.toContain(
      'Use the STAR framework explicitly for every behavioral question',
    )

    // Positive regression guard on the widened gating contract: on a
    // healthy response, EVERY side effect in the :968 block MUST fire.
    // Catches an over-broad gate (e.g. `if (feedback.overall_score == null)`
    // instead of `if (!feedback.degraded)`) that would silently stop
    // XP writes / session summaries / pathway plans / competency updates
    // / mastery streaks / universal-plan session counting for every
    // real user.
    const persistCalls = mockFindByIdAndUpdate.mock.calls.filter(([, update]) => {
      return update && typeof update === 'object' && 'feedback' in update
    })
    expect(persistCalls.length).toBeGreaterThan(0)
    expect(mockUpdatePracticeStats).toHaveBeenCalled()
    expect(mockGenerateSessionSummary).toHaveBeenCalled()
    expect(mockGeneratePathwayPlan).toHaveBeenCalled()
    expect(mockUpdateCompetencyState).toHaveBeenCalled()
    expect(mockUpdateMasteryBatch).toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).toHaveBeenCalled()
  })

  // ── Codex P2 on #317 — server owns the `degraded` flag ──
  //
  // `FeedbackLlmSchema` uses `.passthrough()`, so a hallucinated or
  // prompt-injected `"degraded": true` in Claude's raw JSON would
  // otherwise survive into `feedback` and trip the `!feedback.degraded`
  // gates in the route — suppressing side effects on an otherwise-healthy
  // response AND forcing a regeneration via the cache-bypass at :331.
  // The fix strips any incoming `degraded` field after parse; only the
  // server's fallback paths (inner-fallback :710, outer-catch :1220)
  // set it legitimately.

  it('strips Claude-injected `degraded: true` from healthy JSON', async () => {
    mockCompletion.mockResolvedValueOnce({
      text: JSON.stringify({
        overall_score: 80,
        pass_probability: 'High',
        confidence_level: 'High',
        dimensions: {
          answer_quality: { score: 80, strengths: ['clarity'], weaknesses: [] },
          communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
          engagement_signals: { score: 80, engagement_score: 78, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 75 },
        },
        red_flags: [],
        top_3_improvements: ['A', 'B', 'C'],
        // Hostile payload — could be a hallucination, a jailbreak from a
        // user-supplied JD or resume, or a future Claude fine-tune quirk.
        degraded: true,
      }),
      model: 't', provider: 't', inputTokens: 1000, outputTokens: 500, usedFallback: false, truncated: false,
    })

    const res = await POST(makeReq({
      evals: evals(5),
      plannedQuestionCount: 6,
      answeredCount: 5,
      endReason: 'normal',
    }))
    const json = await res.json()

    // Server stripped the injected flag → response is NOT marked degraded.
    expect(json.degraded).toBeUndefined()
    // Every side effect fires normally. If the strip wasn't there, all
    // of these would be suppressed by the `!feedback.degraded` gates.
    const persistCalls = mockFindByIdAndUpdate.mock.calls.filter(([, update]) => {
      return update && typeof update === 'object' && 'feedback' in update
    })
    expect(persistCalls.length).toBeGreaterThan(0)
    expect(mockUpdatePracticeStats).toHaveBeenCalled()
    expect(mockGenerateSessionSummary).toHaveBeenCalled()
    expect(mockGeneratePathwayPlan).toHaveBeenCalled()
    expect(mockUpdateCompetencyState).toHaveBeenCalled()
    expect(mockUpdateMasteryBatch).toHaveBeenCalled()
    expect(mockAdvanceUniversalPlan).toHaveBeenCalled()
  })
})
