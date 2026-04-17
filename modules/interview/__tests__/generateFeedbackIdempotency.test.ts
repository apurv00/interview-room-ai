/**
 * Work Item G.6 Phase A — idempotency lock on /api/generate-feedback.
 *
 * Validates:
 *   1. First request acquires the lock, runs the pipeline normally.
 *   2. Concurrent duplicate short-circuits with HTTP 202 and no
 *      `completion()` call — the LLM bill is not doubled.
 *   3. After the lock is released, a follow-up call can acquire again
 *      (verifies that the release path runs in the `finally`).
 *   4. A request with no sessionId bypasses locking (legacy fallback).
 *
 * Mocks the feedbackLock module directly so we can simulate
 * SETNX-held scenarios deterministically without spinning up Redis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockAcquire, mockRelease, mockCompletion, mockWarn, mockError, mockInfo,
  mockSessionFindOne,
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockCompletion: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  // F-4: default returns null (no concurrent writer). Tests can
  // override via mockSessionFindOne.mockReturnValueOnce(...) to
  // simulate "another caller already wrote session.feedback" or a
  // mismatched owner filter (findOne returns null when userId
  // doesn't match — tested explicitly in the cross-account case).
  mockSessionFindOne: vi.fn(() => ({
    select: () => ({ lean: () => Promise.resolve(null) }),
  })),
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
    findByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
    findOne: mockSessionFindOne,
  },
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: () => false,
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
  advanceUniversalPlan: vi.fn().mockResolvedValue(null),
}))

vi.mock('@learn/services/masteryTracker', () => ({
  updateMasteryBatch: vi.fn().mockResolvedValue([]),
}))

vi.mock('@learn/services/pathwayBadgeWiring', () => ({
  registerPathwayBadgeWiring: vi.fn(),
}))

import { POST } from '@/app/api/generate-feedback/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(opts: { sessionId?: string; withSession?: boolean } = { withSession: true }) {
  // Post-G.15 G.10's short-form guard fires unconditionally when
  // answeredCount < 3, returning short-form feedback BEFORE the
  // pipeline runs — which would short-circuit these idempotency
  // tests (no completion call → assertions about LLM invocation
  // fail). Use 3 substantive evaluations + matching plannedCount
  // so the route runs the full pipeline.
  const body: Record<string, unknown> = {
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
  }
  if (opts.withSession !== false) {
    body.sessionId = opts.sessionId ?? '507f1f77bcf86cd799439011'
  }
  return new NextRequest('http://localhost:3000/api/generate-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/generate-feedback — G.6 idempotency lock', () => {
  beforeEach(() => {
    mockAcquire.mockReset()
    mockRelease.mockReset()
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
  })

  it('acquires the lock on first request and runs the pipeline', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)

    const res = await POST(makeRequest())

    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(mockAcquire.mock.calls[0][0]).toBe('507f1f77bcf86cd799439011')
    expect(res.status).toBe(200)
    expect(mockCompletion).toHaveBeenCalled()
    expect(mockRelease).toHaveBeenCalledTimes(1) // release in finally
  })

  it('short-circuits with 202 when lock is already held (duplicate request)', async () => {
    mockAcquire.mockResolvedValue(null) // null = contention

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(res.status).toBe(202)
    expect(json.status).toBe('in_progress')
    // The LLM was NOT called — the bill was not doubled.
    expect(mockCompletion).not.toHaveBeenCalled()
    // Nothing to release — we never acquired.
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('releases the lock in finally even when the handler returns early', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    // Early-exit path: zero evaluations
    const body = {
      config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
      transcript: [],
      evaluations: [],
      speechMetrics: [],
      sessionId: '507f1f77bcf86cd799439011',
    }
    const req = new NextRequest('http://localhost:3000/api/generate-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    await POST(req)

    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('releases the lock in finally even when LLM throws (outer catch path)', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockRejectedValue(new Error('anthropic 500'))

    const res = await POST(makeRequest())

    // Outer catch returns a 200 fallback — this is current behavior.
    expect(res.status).toBe(200)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('bypasses locking when sessionId is absent (legacy fallback path)', async () => {
    mockCompletion.mockResolvedValue(happyCompletion)

    const res = await POST(makeRequest({ withSession: false }))

    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockRelease).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  // ─── F-4: concurrent-writer short-circuit ──────────────────────────────
  //
  // Validates that when Redis fails open (lock.acquired === false) OR a
  // parallel caller has already written session.feedback to the DB, the
  // pre-flight read hits and we skip the expensive Claude + side-effect
  // pipeline entirely. Without this, a Redis blip doubles the LLM bill
  // and double-fires every post-feedback side effect.

  it('F-4: returns cached feedback when session.feedback already populated (fail-open race)', async () => {
    // Redis is "down" — lock returns acquired: false (fail-open).
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: false })

    // Meanwhile, the parallel caller already finished and wrote to DB.
    const cachedFeedback = {
      overall_score: 88,
      pass_probability: 'High',
      confidence_level: 'High',
      dimensions: {
        answer_quality: { score: 86, strengths: ['clear'], weaknesses: [] },
        communication: { score: 90, wpm: 140, filler_rate: 0.02, pause_score: 80, rambling_index: 0.1 },
        engagement_signals: { score: 88, engagement_score: 85, confidence_trend: 'stable', energy_consistency: 0.85, composure_under_pressure: 80 },
      },
      red_flags: [],
      top_3_improvements: ['already', 'written', 'to DB'],
    }
    mockSessionFindOne.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve({ feedback: cachedFeedback }) }),
    })

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    // The critical assertion — the LLM was NOT called again.
    expect(mockCompletion).not.toHaveBeenCalled()
    // Returned feedback matches the cached one, not a fresh generation.
    expect(json.overall_score).toBe(88)
    expect(json.top_3_improvements).toEqual(['already', 'written', 'to DB'])
  })

  it('F-4: proceeds with generation when session.feedback is null (normal first run)', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)
    // Default mockSessionFindOne returns null → no concurrent writer.

    const res = await POST(makeRequest())

    expect(res.status).toBe(200)
    // LLM ran normally — the pre-flight check is non-intrusive on the
    // cold path.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
  })

  it('F-4: pre-flight DB read failure is non-fatal (falls through to normal pipeline)', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)
    // Simulate a Mongo outage on the pre-flight read.
    mockSessionFindOne.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.reject(new Error('Mongo ECONNREFUSED')) }),
    })

    const res = await POST(makeRequest())

    expect(res.status).toBe(200)
    // Pipeline still runs — pre-flight is best-effort, not a gate.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    // Warn was logged (but not error — non-fatal).
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
      expect.stringContaining('pre-flight session read failed'),
    )
  })

  it('F-4: pre-flight lookup is owner-scoped (no cross-account feedback leak)', async () => {
    // Codex P1 finding on PR #273: without {_id, userId} scoping the
    // pre-flight read would return any session's feedback by id, turning
    // /api/generate-feedback into a read oracle for other users' scores.
    // This test asserts the route calls findOne with a userId filter so
    // a non-matching caller never receives the cached feedback even
    // when the sessionId matches an existing row.
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: false })
    mockCompletion.mockResolvedValue(happyCompletion)

    // Caller is user '...9099' (mock session above). The session in
    // Mongo belongs to a DIFFERENT user, so findOne({_id, userId: 9099})
    // must return null even though the row exists.
    mockSessionFindOne.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve(null) }),
    })

    await POST(makeRequest())

    // The filter passed to findOne must include the caller's userId,
    // not just the sessionId. Catching the filter shape here is the
    // regression guard that would have caught the original leak.
    expect(mockSessionFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.any(String),
        userId: '507f1f77bcf86cd799439099',
      }),
    )
    // Pipeline continued normally — findOne returned null means no
    // concurrent writer visible to this user, so we generate freshly.
    expect(mockCompletion).toHaveBeenCalledTimes(1)
  })

  // ─── F-3: aggregate side-effect summary log ─────────────────────────────
  //
  // Five post-feedback side effects (practiceStats, competency,
  // sessionSummary, weaknessClusters, pathwayPlan) are fire-and-forget.
  // Before F-3, a failed side effect only logged a per-call warn with
  // no sessionId, so ops couldn't correlate failures to an interview
  // or see how many of the N calls succeeded. F-3 wraps them in
  // Promise.allSettled and emits one aggregate info line per session.

  it('F-3: emits aggregate summary log with succeeded count when all side effects pass', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    // Side effects are fire-and-forget; let their promises settle.
    // Microtask flush + a short macrotask covers the allSettled chain.
    await new Promise((r) => setTimeout(r, 0))

    const summaryCall = mockInfo.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('post-feedback side effects settled'),
    )
    expect(summaryCall).toBeTruthy()
    const [context] = summaryCall as [Record<string, unknown>, string]
    expect(context.totalSideEffects).toBe(6) // no weaknessClusters when no flags; +masteryTracking, +universalPlanAdvance
    expect(context.succeeded).toBe(6)
    expect(context.failedCount).toBe(0)
    expect(context.failed).toBeUndefined()
    expect(context.sessionId).toBe('507f1f77bcf86cd799439011')
  })

  it('F-3: aggregate summary lists failed side effects by name', async () => {
    mockAcquire.mockResolvedValue({ lockKey: 'k', lockValue: 'v', acquired: true })
    mockCompletion.mockResolvedValue(happyCompletion)

    // Reach into the mocked service modules — the factory returned
    // real vi.fn() instances that are cached per module, so we can
    // override the next call without rebuilding the mock.
    const competencyModule = await import('@learn/services/competencyService')
    vi.mocked(competencyModule.updateCompetencyState).mockRejectedValueOnce(
      new Error('competency DB down'),
    )
    const pathwayModule = await import('@learn/services/pathwayPlanner')
    vi.mocked(pathwayModule.generatePathwayPlan).mockRejectedValueOnce(
      new Error('pathway OOM'),
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    await new Promise((r) => setTimeout(r, 0))

    const summaryCall = mockInfo.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('post-feedback side effects settled'),
    )
    expect(summaryCall).toBeTruthy()
    const [context] = summaryCall as [Record<string, unknown>, string]
    expect(context.totalSideEffects).toBe(6)
    expect(context.succeeded).toBe(4)
    expect(context.failedCount).toBe(2)
    const failed = context.failed as Array<{ name: string; reason: string }>
    expect(failed.map((f) => f.name).sort()).toEqual(['competency', 'pathwayPlan'])
    expect(failed.find((f) => f.name === 'competency')?.reason).toContain('competency DB down')
    expect(failed.find((f) => f.name === 'pathwayPlan')?.reason).toContain('pathway OOM')
  })
})
