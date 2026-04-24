/**
 * PR #321 (follow-up to #320) — side-effect outcome observability.
 *
 * Production session 69eb6689c6cbd204bd2b8266 (2026-04-24) generated a
 * feedback response with score but an empty pathway plan. Root cause
 * narrowed in audit round-5 to one of:
 *   1. `FEATURE_FLAG_PATHWAY_PLANNER=false` in Vercel env → both
 *      `generatePathwayPlan` and `getCurrentPathway` return null silently
 *      → pathway page renders "Complete an interview to generate a plan"
 *      (wrong message for a user who just completed one).
 *   2. Fire-and-forget `pathwayPlan` side-effect rejected → aggregate
 *      log line at `aiLogger.info` level showed it, but user had no
 *      client-facing indication.
 *   3. `InterviewSession.findByIdAndUpdate` persist failure — NOT part
 *      of the `sideEffects[]` array, so the aggregate log couldn't
 *      report it; user reload triggered cache-miss + full Claude
 *      regenerate, paying twice.
 *
 * This PR plugs all three:
 *   - Response body exposes `sideEffectOutcomes: Array<{name, status}>`
 *     with `status: 'scheduled' | 'skipped'` (determinable synchronously
 *     at response time; feature-flag-off paths mark the pathway as
 *     `skipped` and push a user-visible red_flag).
 *   - Mongo persist folded into the `sideEffects[]` array so aggregate
 *     log correctly reports persist failures.
 *
 * These tests pin the contract: they MUST fail against pre-PR code
 * and pass after the route changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockAcquire, mockRelease, mockCompletion, mockWarn, mockError, mockInfo,
  mockSessionFindOne, mockFindByIdAndUpdate, mockIsFeatureEnabled,
  mockGeneratePathwayPlan, mockEvaluateSession,
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockCompletion: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockSessionFindOne: vi.fn(() => ({
    select: () => ({ lean: () => Promise.resolve(null) }),
  })),
  mockFindByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
  mockIsFeatureEnabled: vi.fn(() => true),
  mockGeneratePathwayPlan: vi.fn().mockResolvedValue(undefined),
  mockEvaluateSession: vi.fn().mockResolvedValue({}),
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

vi.mock('@shared/services/feedbackLock', () => ({
  acquireFeedbackLock: mockAcquire,
  releaseFeedbackLock: mockRelease,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/scoreTelemetry', () => ({
  recordScoreDelta: vi.fn().mockResolvedValue(null),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewSession: {
    findByIdAndUpdate: mockFindByIdAndUpdate,
    findOne: mockSessionFindOne,
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
  JSON_OUTPUT_RULE: '',
}))

vi.mock('@interview/config/interviewConfig', () => ({
  getDomainLabel: () => 'Product Manager',
  getPressureQuestionIndex: () => 99,
  getQuestionCount: () => 6,
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
  evaluateSession: mockEvaluateSession,
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
  generatePathwayPlan: mockGeneratePathwayPlan,
  advanceUniversalPlan: vi.fn().mockResolvedValue(null),
}))

vi.mock('@learn/services/masteryTracker', () => ({
  updateMasteryBatch: vi.fn().mockResolvedValue([]),
}))

vi.mock('@learn/services/pathwayBadgeWiring', () => ({
  registerPathwayBadgeWiring: vi.fn(),
}))

vi.mock('@learn/services/practiceStatsService', () => ({
  updatePracticeStats: vi.fn().mockResolvedValue(undefined),
  deriveStrongWeakDimensions: () => ({ strongDimensions: [], weakDimensions: [] }),
}))

vi.mock('@learn/services/weaknessClusterLinker', () => ({
  inferLinkedCompetencies: () => [],
}))

import { POST } from '@/app/api/generate-feedback/route'

const happyCompletion = {
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
  model: 'test-model',
  provider: 'test',
  inputTokens: 3000,
  outputTokens: 2000,
  usedFallback: false,
  truncated: false,
}

function makeRequest(sessionId = '507f1f77bcf86cd799439011') {
  const body = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [],
    evaluations: [
      { questionIndex: 0, question: 'Q1?', answer: 'A reasonably substantive answer.',
        relevance: 70, structure: 65, specificity: 60, ownership: 75,
        probeDecision: { shouldProbe: false } },
      { questionIndex: 1, question: 'Q2?', answer: 'Another substantive answer.',
        relevance: 70, structure: 65, specificity: 60, ownership: 75,
        probeDecision: { shouldProbe: false } },
      { questionIndex: 2, question: 'Q3?', answer: 'And a third answer.',
        relevance: 70, structure: 65, specificity: 60, ownership: 75,
        probeDecision: { shouldProbe: false } },
    ],
    speechMetrics: [],
    answeredCount: 3,
    plannedQuestionCount: 3,
    sessionId,
  }
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForAggregateLog(): Promise<Record<string, unknown> | null> {
  // The aggregate "post-feedback side effects settled" log fires from a
  // Promise.allSettled().then(...) scheduled INSIDE the handler. The
  // handler returns before it fires — we need to give microtasks a few
  // ticks to drain. 20ms is comfortably above the typical resolved-
  // promise resolution latency in a mocked environment.
  await new Promise((r) => setTimeout(r, 20))
  const aggregateCall = mockInfo.mock.calls.find(
    (call) => typeof call[1] === 'string' && call[1].includes('post-feedback side effects settled'),
  )
  return aggregateCall ? (aggregateCall[0] as Record<string, unknown>) : null
}

describe('POST /api/generate-feedback — side-effect outcome observability (PR #321)', () => {
  beforeEach(() => {
    mockAcquire.mockReset()
    mockRelease.mockReset()
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
    mockFindByIdAndUpdate.mockReset()
    mockFindByIdAndUpdate.mockResolvedValue(undefined)
    mockIsFeatureEnabled.mockReset()
    mockIsFeatureEnabled.mockReturnValue(true)
    mockGeneratePathwayPlan.mockReset()
    mockGeneratePathwayPlan.mockResolvedValue(undefined)
    mockEvaluateSession.mockReset()
    mockEvaluateSession.mockResolvedValue({})

    // Default: feedback lock acquires cleanly, completion succeeds.
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)
  })

  // ── BUG #4 (P1): feature flag off → pathway skipped + red_flag ──
  //
  // When `FEATURE_FLAG_PATHWAY_PLANNER=false` in production, the
  // side-effect still "succeeds" (generatePathwayPlan returns null
  // synchronously). The aggregate log reported 0 failures. User saw
  // empty pathway with the wrong "Complete an interview" message.
  // Fix: preflight the feature flag at response-build time, mark the
  // outcome as 'skipped', and push a red_flag so the UI + user know.
  it('marks pathwayPlan as skipped and pushes red_flag when pathway_planner flag is off', async () => {
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag !== 'pathway_planner')

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json() as {
      red_flags?: string[]
      sideEffectOutcomes?: Array<{ name: string; status: string }>
    }

    // Assert 1: outcome list includes pathwayPlan with 'skipped' status.
    expect(body.sideEffectOutcomes).toBeDefined()
    const pathwayOutcome = body.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan')
    expect(pathwayOutcome?.status).toBe('skipped')

    // Assert 2: the pathway-unavailable red_flag is present.
    const flag = body.red_flags?.find((f) => /pathway/i.test(f))
    expect(flag).toBeDefined()
    expect(flag).toMatch(/(unavailable|temporarily|refresh)/i)

    // Assert 3: generatePathwayPlan was NOT called (preflight skipped it).
    expect(mockGeneratePathwayPlan).not.toHaveBeenCalled()
  })

  // ── BUG #4 (P1): feature flag on → pathway scheduled, no extra flag ──
  it('marks pathwayPlan as scheduled and adds no red_flag when flag is on', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)

    const res = await POST(makeRequest())
    const body = await res.json() as {
      red_flags?: string[]
      sideEffectOutcomes?: Array<{ name: string; status: string }>
    }

    const pathwayOutcome = body.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan')
    expect(pathwayOutcome?.status).toBe('scheduled')

    const pathwayFlag = body.red_flags?.find((f) => /pathway/i.test(f))
    expect(pathwayFlag).toBeUndefined()
  })

  // ── BUG #5 (P2): Mongo persist folded into sideEffects[] ──
  //
  // Before: findByIdAndUpdate had its own try/catch that warn-logged
  // and continued. Aggregate log didn't cover it. After: persist is
  // a tracked side-effect. Its failure shows up in the aggregate log's
  // `failed` list and in the response's sideEffectOutcomes as
  // status: 'scheduled' at response time (actual failure detected
  // async by allSettled).
  it('includes persist in sideEffects tracking so aggregate log catches persist failures', async () => {
    mockFindByIdAndUpdate.mockRejectedValueOnce(new Error('mongo timeout'))

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json() as {
      sideEffectOutcomes?: Array<{ name: string; status: string }>
    }

    // Assert 1: persist is in the scheduled list in the response.
    const persistOutcome = body.sideEffectOutcomes?.find((o) => o.name === 'persist')
    expect(persistOutcome).toBeDefined()
    expect(persistOutcome?.status).toBe('scheduled')

    // Assert 2: aggregate log (fires from Promise.allSettled().then)
    // reports persist in the failed list.
    const aggregate = await waitForAggregateLog()
    expect(aggregate).not.toBeNull()
    const failed = (aggregate as { failed?: Array<{ name: string; reason: string }> }).failed
    expect(failed).toBeDefined()
    expect(failed?.some((f) => f.name === 'persist')).toBe(true)
  })

  // ── Codex P2 on PR #321 — persist captures post-mutation feedback ──
  //
  // The pathway_planner-off branch mutates `feedback.red_flags` via
  // `.push(PATHWAY_UNAVAILABLE_FLAG)`. `findByIdAndUpdate` captures
  // the `feedback` reference synchronously when the update object is
  // built, so the red_flag push MUST happen before the persist
  // side-effect is scheduled — otherwise reload/poll flows reading
  // `session.feedback` from Mongo would still see the stale pre-flag
  // version, and the pathway page would keep rendering the wrong
  // "Complete an interview to generate a plan" CTA.
  it('persists the pathway-unavailable red_flag when pathway_planner is off', async () => {
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag !== 'pathway_planner')

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    // findByIdAndUpdate was called with the post-mutation feedback.
    // Inspect the arguments directly — the second argument (update op)
    // carries the feedback field whose red_flags must contain the new
    // pathway-unavailable flag.
    expect(mockFindByIdAndUpdate).toHaveBeenCalled()
    const updateOp = mockFindByIdAndUpdate.mock.calls[0][1] as {
      feedback?: { red_flags?: string[] }
    }
    const persistedRedFlags = updateOp.feedback?.red_flags
    expect(persistedRedFlags).toBeDefined()
    expect(persistedRedFlags?.some((f: string) => /pathway/i.test(f))).toBe(true)
  })

  // ── Codex P2 on PR #321 — red_flags may be undefined on partial Claude payloads ──
  //
  // FeedbackLlmSchema declares `red_flags: z.array(z.string()).optional()`
  // (validators/interview.ts:311) so Claude can legally omit the field.
  // The handler tolerates Zod-failing JSON via `.passthrough()` — a
  // partial payload with no `red_flags` reaches the pathway preflight
  // with `feedback.red_flags === undefined`. Calling `.includes` /
  // `.push` on undefined would throw, drop to the outer catch, and
  // return a degraded fallback instead of the normal response. The
  // fix normalizes the array via `Array.isArray(...) ? ... : []`
  // before mutation.
  it('does NOT crash when Claude omits red_flags and pathway_planner is off', async () => {
    mockIsFeatureEnabled.mockImplementation((flag: string) => flag !== 'pathway_planner')

    // Partial Claude payload — no top-level `red_flags` field at all.
    // Schema.passthrough() + .optional() means this passes Zod; the
    // handler proceeds. Pre-fix code would TypeError here.
    mockCompletion.mockResolvedValueOnce({
      text: JSON.stringify({
        overall_score: 72,
        pass_probability: 'Medium',
        confidence_level: 'High',
        dimensions: {
          answer_quality: { score: 70, strengths: [], weaknesses: [] },
          communication: { score: 72, wpm: 140, filler_rate: 0.04, pause_score: 70, rambling_index: 0.2 },
          engagement_signals: { score: 70, engagement_score: 68, confidence_trend: 'stable', energy_consistency: 0.7, composure_under_pressure: 65 },
        },
        top_3_improvements: ['A', 'B', 'C'],
        // red_flags intentionally omitted
      }),
      model: 'test-model',
      provider: 'test',
      inputTokens: 3000,
      outputTokens: 2000,
      usedFallback: false,
      truncated: false,
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json() as {
      red_flags?: string[]
      degraded?: boolean
    }

    // Must have recovered + pushed the pathway red_flag without
    // throwing. degraded should be falsy (normal path, not outer catch).
    expect(body.degraded).toBeFalsy()
    expect(Array.isArray(body.red_flags)).toBe(true)
    expect(body.red_flags?.some((f) => /pathway/i.test(f))).toBe(true)
  })

  // ── Codex P1 on PR #321 — Mongoose Query double-observation ──
  //
  // Mongoose `Model.findByIdAndUpdate(...)` returns a single-execution
  // Query (thenable, not a Promise). `fireAndTrack` attaches `.catch()`
  // (execution #1); the aggregate `Promise.allSettled(sideEffects.map(s
  // => s.promise))` observes the SAME thenable again (execution #2),
  // which rejects with "Query was already executed". The aggregate log
  // would falsely report persist as `failed` on every successful
  // production run — while tests using Promise-returning mocks (like
  // this suite's default `mockResolvedValue(undefined)`) wouldn't
  // surface the bug at all. The fix wraps the Query in
  // `Promise.resolve().then(() => query)` so the OUTER Promise is
  // observed multiple times safely.
  //
  // This test uses a thenable that rejects on the 2nd `.then()` call —
  // a faithful model of Mongoose's single-execution contract. Against
  // the pre-fix code the aggregate would list persist as failed; with
  // the wrapper it stays absent from the failed list even though the
  // simulated Query is observed twice.
  it('handles single-execution thenables like Mongoose queries without false-reporting persist as failed', async () => {
    let observationCount = 0
    mockFindByIdAndUpdate.mockImplementationOnce(() => {
      // Mimic a Mongoose Query: on FIRST .then the query succeeds,
      // on SECOND .then Mongoose throws "Query was already executed".
      // The real class also implements .catch() as a pass-through.
      return {
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (err: unknown) => unknown) {
          observationCount += 1
          if (observationCount === 1) {
            return Promise.resolve().then(onFulfilled as () => unknown)
          }
          const err = new Error('Query was already executed')
          return onRejected
            ? Promise.resolve(onRejected(err))
            : Promise.reject(err)
        },
        catch(onRejected: (err: unknown) => unknown) {
          return this.then((v: unknown) => v, onRejected)
        },
      }
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    // Wait for allSettled aggregate.
    const aggregate = await waitForAggregateLog()
    expect(aggregate).not.toBeNull()
    const failed = (aggregate as { failed?: Array<{ name: string; reason: string }> }).failed
    // With the wrapper: persist is observed exactly once (inside the
    // Promise.resolve().then(...) callback), so the aggregate does NOT
    // list it as failed. Without the wrapper, `persist` would be in
    // `failed` with reason "Query was already executed".
    expect((failed ?? []).some((f) => f.name === 'persist')).toBe(false)
  })

  // ── Backward compatibility: response shape remains valid ──
  it('still returns a valid FeedbackData shape with the new field', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)

    const res = await POST(makeRequest())
    const body = await res.json() as Record<string, unknown>

    // Core fields intact — existing clients keep working.
    expect(body.overall_score).toBeTypeOf('number')
    expect(body.dimensions).toBeDefined()
    expect(Array.isArray(body.red_flags)).toBe(true)
    expect(Array.isArray(body.top_3_improvements)).toBe(true)

    // New field is a flat array with name/status pairs.
    expect(Array.isArray(body.sideEffectOutcomes)).toBe(true)
    const outcomes = body.sideEffectOutcomes as Array<{ name: string; status: string }>
    for (const o of outcomes) {
      expect(typeof o.name).toBe('string')
      expect(['scheduled', 'skipped']).toContain(o.status)
    }
  })
})
