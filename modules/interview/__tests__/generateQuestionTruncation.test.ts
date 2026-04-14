/**
 * Contract test for app/api/generate-question/route.ts truncation handling.
 *
 * Validates the retry-then-fallback flow added to handle provider-level
 * truncation signals. The P0 bug: `interview.generate-question` has
 * max_tokens=300 which is too small at Q15+ when the system prompt has
 * ballooned, so the model cuts off mid-question. Previously the route
 * shipped truncated text to the candidate. Now it:
 *   1. Retries ONCE with maxTokens: 500 if the first call truncated.
 *   2. Returns 503 with isFallback=true if the retry also truncated,
 *      so the client's getNextFallbackQuestion path takes over.
 *   3. Behaves normally when completion is not truncated (no retry, no warn).
 *
 * We mock composeApiRoute to a passthrough so we can invoke the handler
 * without wiring auth/rate-limit/redis. All downstream deps used by the
 * handler are mocked to no-ops; the `completion` seam is the only one
 * whose behavior matters to these assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockCompletion, mockWarn, mockError, mockInfo, mockDebug } = vi.hoisted(() => ({
  mockCompletion: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockDebug: vi.fn(),
}))

// Passthrough composeApiRoute — skips auth, rate limiting, and validation
// so we can exercise the handler body directly. Schema parsing is still
// applied so a malformed test body fails fast.
vi.mock('@shared/middleware/composeApiRoute', () => ({
  composeApiRoute: (opts: {
    schema?: { parse: (x: unknown) => unknown }
    handler: (
      req: NextRequest,
      ctx: { user: unknown; body: unknown; params: Record<string, string> },
    ) => Promise<Response>
  }) => {
    return async (req: NextRequest): Promise<Response> => {
      const raw = await req.json()
      const body = opts.schema ? opts.schema.parse(raw) : raw
      return opts.handler(req, {
        user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
        body,
        params: {},
      })
    }
  },
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mockWarn, error: mockError, info: mockInfo, debug: mockDebug },
  logger: { warn: mockWarn, error: mockError, info: mockInfo, debug: mockDebug },
}))

vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

// Short-circuit DB path — connectDB throws, caller's try/catch falls to
// FALLBACK_DOMAINS/FALLBACK_DEPTHS (which we also mock to empty).
vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockRejectedValue(new Error('test: no db')),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.reject(new Error('test')) }) }) },
  InterviewDomain: { findOne: () => ({ lean: () => Promise.reject(new Error('test')) }) },
  InterviewDepth: { findOne: () => ({ lean: () => Promise.reject(new Error('test')) }) },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DOMAINS: [],
  FALLBACK_DEPTHS: [],
}))

vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: () => false,
}))

vi.mock('@shared/services/promptSecurity', () => ({
  DATA_BOUNDARY_RULE: '',
}))

vi.mock('@interview/services/core/skillLoader', () => ({
  getSkillSections: vi.fn().mockResolvedValue(null),
  selectSkillQuestions: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/config/companyProfiles', () => ({
  findCompanyProfile: () => null,
  buildCompanyPromptContext: () => '',
}))

vi.mock('@interview/services/persona/personalizationEngine', () => ({
  generateSessionBrief: vi.fn().mockRejectedValue(new Error('test')),
  briefToPromptContext: () => '',
}))

vi.mock('@interview/services/persona/retrievalService', () => ({
  getQuestionBankContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: vi.fn().mockResolvedValue(null),
  getOrLoadResumeContext: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  getOrLoadSessionConfig: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/flow', () => ({
  resolveFlow: () => null,
  buildFlowPromptContext: () => ({ promptBlock: '' }),
}))

// Import AFTER mocks.
import { POST } from '@/app/api/generate-question/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(overrides: Record<string, unknown> = {}): NextRequest {
  const body = {
    config: {
      role: 'pm',
      experience: '0-2',
      duration: 30,
    },
    questionIndex: 0,
    previousQA: [],
    ...overrides,
  }
  return new NextRequest('http://localhost:3000/api/generate-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function completionResult(text: string, truncated: boolean) {
  return {
    text,
    model: 'test-model',
    provider: 'test-provider',
    inputTokens: 100,
    outputTokens: 50,
    usedFallback: false,
    truncated,
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/generate-question — truncation handling', () => {
  beforeEach(() => {
    // reset clears both call history AND queued .mockResolvedValueOnce values
    mockCompletion.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
    mockDebug.mockReset()
  })

  it('returns 503 isFallback when both initial call and retry are truncated', async () => {
    mockCompletion
      .mockResolvedValueOnce(completionResult('First call cut off mid-sent', true))
      .mockResolvedValueOnce(completionResult('Retry also clipped somewhere', true))

    const res = await POST(makeRequest())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.isFallback).toBe(true)
    expect(body.error).toBe('question_generation_truncated')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    // Retry must pass an expanded maxTokens override
    const retryCallArgs = mockCompletion.mock.calls[1][0]
    expect(retryCallArgs.maxTokens).toBe(500)
  })

  it('returns 200 with retry text when initial is truncated but retry succeeds', async () => {
    mockCompletion
      .mockResolvedValueOnce(completionResult('Initial cut off', true))
      .mockResolvedValueOnce(completionResult('Full retry answer.', false))

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.question).toBe('Full retry answer.')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    expect(mockWarn).toHaveBeenCalled()
  })

  it('returns 200 with primary text when no truncation (no retry, no warn)', async () => {
    mockCompletion.mockResolvedValueOnce(completionResult('Clean primary answer.', false))

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.question).toBe('Clean primary answer.')
    expect(mockCompletion).toHaveBeenCalledTimes(1)
    // No truncation warning should fire on the happy path
    const truncationWarnCalls = mockWarn.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.toLowerCase().includes('trunc'),
    )
    expect(truncationWarnCalls).toHaveLength(0)
  })
})
