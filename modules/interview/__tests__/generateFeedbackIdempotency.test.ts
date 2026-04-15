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
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
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
  InterviewSession: { findByIdAndUpdate: vi.fn().mockResolvedValue(undefined) },
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
}))

import { POST } from '@/app/api/generate-feedback/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(opts: { sessionId?: string; withSession?: boolean } = { withSession: true }) {
  const body: Record<string, unknown> = {
    config: { role: 'pm', experience: '0-2', duration: 30, interviewType: 'screening' },
    transcript: [],
    evaluations: [
      {
        questionIndex: 0, question: 'Q?', answer: 'A reasonably substantive answer.',
        relevance: 70, structure: 65, specificity: 60, ownership: 75,
        probeDecision: { shouldProbe: false },
      },
    ],
    speechMetrics: [],
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
})
