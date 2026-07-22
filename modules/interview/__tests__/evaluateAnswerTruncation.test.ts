/**
 * Work Item G.3 — truncation detection in /api/evaluate-answer.
 *
 * Validates the retry-then-mark flow:
 *   1. First completion truncated → retry with maxTokens: 800
 *      (was 500; raised 2026-07-11 to stay above the slot primary of 500
 *      after the low-reasoning headroom bump).
 *   2. Retry OK → return evaluation with status='ok' (default, implicit).
 *   3. Retry also truncated → evaluation.status = 'truncated' so the
 *      downstream generate-feedback aggregation can flag/skip it.
 *   4. Non-truncated first call → no retry, no extra completion.
 *
 * Uses the same passthrough-composeApiRoute pattern as
 * generateQuestionTruncation.test.ts so the handler body runs without
 * the auth/rate-limit/validate middleware chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockCompletionStream, mockWarn, mockError, mockInfo, mockCaptureScoringConfig, mockRecordScoringReceipt } = vi.hoisted(() => ({
  mockCompletionStream: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockCaptureScoringConfig: vi.fn(),
  mockRecordScoringReceipt: vi.fn(),
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
      user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
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
  completion: mockCompletionStream,
  completionStream: mockCompletionStream,
}))

vi.mock('@shared/services/usageTracking', () => ({
  trackUsage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/services/scoringProvenance', () => ({
  ANSWER_EVALUATION_CONTRACT_VERSION: 'answer-evaluation.v1',
  captureModelConfigSnapshot: mockCaptureScoringConfig,
  recordJobsAnswerScoringReceipt: mockRecordScoringReceipt,
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  connectDBIfNeeded: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models', () => ({
  User: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
  InterviewDepth: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}))

vi.mock('@shared/db/seed', () => ({
  FALLBACK_DEPTHS: [
    {
      slug: 'screening',
      evaluationCriteria: '',
      scoringDimensions: [
        { name: 'relevance', label: 'Relevance', weight: 0.25 },
        { name: 'structure', label: 'STAR', weight: 0.25 },
        { name: 'specificity', label: 'Specificity', weight: 0.25 },
        { name: 'ownership', label: 'Ownership', weight: 0.25 },
      ],
    },
  ],
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
}))

vi.mock('@interview/services/core/skillLoader', () => ({
  getSkillSections: vi.fn().mockResolvedValue(null),
}))

vi.mock('@interview/config/companyProfiles', () => ({
  findCompanyProfile: () => null,
}))

vi.mock('@interview/services/eval/evaluationEngine', () => ({
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

import { POST } from '@/app/api/evaluate-answer/route'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(
  answer = 'A reasonably long answer about a team conflict resolution.',
  jobsPractice = false,
) {
  const body = {
    config: {
      role: 'pm',
      experience: '0-2',
      duration: 30,
      interviewType: 'screening',
      ...(jobsPractice && { attribution: { source: 'jobs', jobId: 'job-1' } }),
    },
    question: 'Tell me about a time you resolved a conflict.',
    answer,
    questionIndex: 0,
    sessionId: '507f1f77bcf86cd799439011',
  }
  return new NextRequest('http://localhost:3000/api/evaluate-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ANSWER_MODEL = {
  model: 'test-model',
  provider: 'test-provider',
  maxTokens: 500,
  useToonInput: false,
}

function completionResult(text: string, truncated: boolean) {
  return {
    text,
    model: ANSWER_MODEL.model,
    provider: ANSWER_MODEL.provider,
    inputTokens: 100,
    outputTokens: truncated ? 250 : 120,
    usedFallback: false,
    attemptKind: 'primary' as const,
    truncated,
  }
}

const validScores = JSON.stringify({
  relevance: 75,
  structure: 70,
  specificity: 65,
  ownership: 80,
  primaryGap: 'specificity',
  primaryStrength: 'ownership',
  answerSummary: 'Resolved conflict via 1:1 escalation',
  shouldProbe: false,
  probeType: null,
  probeTarget: null,
  isPivot: false,
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/evaluate-answer — G.3 truncation handling', () => {
  beforeEach(() => {
    mockCompletionStream.mockReset()
    mockWarn.mockReset()
    mockError.mockReset()
    mockInfo.mockReset()
    mockCaptureScoringConfig.mockReset()
    mockRecordScoringReceipt.mockReset()
    mockCaptureScoringConfig.mockResolvedValue({
      taskSlot: 'interview.evaluate-answer',
      resolved: ANSWER_MODEL,
      source: 'L3-Mongo',
      authoritative: true,
    })
    mockRecordScoringReceipt.mockResolvedValue(true)
  })

  it('does not retry when first completion is not truncated', async () => {
    mockCompletionStream.mockResolvedValueOnce(completionResult(validScores, false))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletionStream).toHaveBeenCalledTimes(1)
    expect(json.status).toBe('ok')
    expect(json.failure).toBeUndefined()
    expect(json.relevance).toBe(75)
    expect(mockCaptureScoringConfig).not.toHaveBeenCalled()
  })

  it('records exact scorer provenance only for Jobs-attributed config', async () => {
    mockCompletionStream.mockResolvedValueOnce(completionResult(validScores, false))

    await POST(makeRequest(undefined, true))

    expect(mockCaptureScoringConfig).toHaveBeenCalledWith('interview.evaluate-answer')
    expect(mockCompletionStream).toHaveBeenCalledWith(expect.objectContaining({
      resolvedModel: ANSWER_MODEL,
    }))
    expect(mockRecordScoringReceipt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: '507f1f77bcf86cd799439011',
      userId: 'test-user-1',
      contractVersion: 'answer-evaluation.v1',
      evaluation: expect.objectContaining({ relevance: 75, status: 'ok' }),
      result: expect.objectContaining({ attemptKind: 'primary' }),
    }))
  })

  it('retries once with expanded maxTokens when initial call truncated, succeeds on retry', async () => {
    mockCompletionStream
      .mockResolvedValueOnce(completionResult('{"relevance": 70, "struc', true))
      .mockResolvedValueOnce(completionResult(validScores, false))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletionStream).toHaveBeenCalledTimes(2)
    // Second call must include expanded maxTokens override
    const retryCall = mockCompletionStream.mock.calls[1][0] as { maxTokens?: number }
    expect(retryCall.maxTokens).toBe(800)
    // Evaluation reflects the retry's data, not the truncated first attempt
    expect(json.status).toBe('ok')
    expect(json.relevance).toBe(75)
    expect(mockWarn).toHaveBeenCalled()
  })

  it('pins the Jobs retry to one scorer snapshot and records only the accepted retry', async () => {
    mockCompletionStream
      .mockResolvedValueOnce(completionResult('{"relevance": 70, "struc', true))
      .mockResolvedValueOnce(completionResult(validScores, false))

    const response = await POST(makeRequest(undefined, true))

    expect(response.status).toBe(200)
    expect(mockCaptureScoringConfig).toHaveBeenCalledOnce()
    expect(mockCompletionStream).toHaveBeenCalledTimes(2)
    expect(mockCompletionStream.mock.calls[0][0]).toMatchObject({ resolvedModel: ANSWER_MODEL })
    expect(mockCompletionStream.mock.calls[1][0]).toMatchObject({
      resolvedModel: ANSWER_MODEL,
      maxTokens: 800,
    })
    expect(mockRecordScoringReceipt).toHaveBeenCalledOnce()
    expect(mockRecordScoringReceipt).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { maxTokens: 800 },
      result: expect.objectContaining({ attemptKind: 'primary', truncated: false }),
    }))
  })

  it('marks evaluation.status = "truncated" when retry also truncates (parseable partial)', async () => {
    // Realistic truncation shape: the model emitted a complete JSON
    // object but the `truncated` flag is still set because stop_reason
    // was max_tokens. This happens when maxTokens lands exactly at the
    // closing brace or when the prompt asked for more fields than the
    // budget allowed but the object itself parsed.
    const partial = JSON.stringify({
      relevance: 72,
      structure: 68,
      specificity: 60,
      ownership: 70,
    })
    mockCompletionStream
      .mockResolvedValueOnce(completionResult('{"relevance": 70, "struc', true))
      .mockResolvedValueOnce(completionResult(partial, true))

    const res = await POST(makeRequest(undefined, true))
    const json = await res.json()

    expect(mockCompletionStream).toHaveBeenCalledTimes(2)
    expect(json.status).toBe('truncated')
    expect(json.relevance).toBe(72)
    expect(mockRecordScoringReceipt).not.toHaveBeenCalled()
  })

  it('falls through to status = "failed" when retry parse also fails', async () => {
    // When the retry is both truncated AND un-parseable, the outer
    // catch kicks in and status is "failed" (not "truncated") — we
    // cannot extract a dim score we don't have.
    mockCompletionStream
      .mockResolvedValueOnce(completionResult('{"relevance": 70, "struc', true))
      .mockResolvedValueOnce(completionResult('{"relevance": 72, "sp', true))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(mockCompletionStream).toHaveBeenCalledTimes(2)
    expect(json.status).toBe('failed')
    expect(json.failure).toMatchObject({
      source: 'server',
      reason: 'server_parse_error',
      taskSlot: 'interview.evaluate-answer',
    })
    expect(mockError).toHaveBeenCalled()
  })

  it('returns status = "failed" when completion throws (outer catch)', async () => {
    mockCompletionStream.mockRejectedValueOnce(new Error('network down'))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(json.status).toBe('failed')
    expect(json.failure).toMatchObject({
      source: 'server',
      reason: 'server_llm_error',
      message: 'network down',
      taskSlot: 'interview.evaluate-answer',
    })
    // Keeps the legacy placeholder shape so old clients don't crash.
    expect(typeof json.relevance).toBe('number')
    expect(mockError).toHaveBeenCalled()
  })

  it('classifies ModelRouter all-attempts failures explicitly', async () => {
    mockCompletionStream.mockRejectedValueOnce(new Error('ModelRouter: all attempts failed for interview.evaluate-answer'))

    const res = await POST(makeRequest())
    const json = await res.json()

    expect(json.status).toBe('failed')
    expect(json.failure).toMatchObject({
      source: 'server',
      reason: 'server_modelrouter_failed',
      message: 'ModelRouter: all attempts failed for interview.evaluate-answer',
      taskSlot: 'interview.evaluate-answer',
    })
    expect(json.relevance).toBe(60)
    expect(json.structure).toBe(55)
    expect(json.specificity).toBe(55)
    expect(json.ownership).toBe(60)
  })

  it('short-circuits with score=0 when answer is empty — no completion call', async () => {
    const res = await POST(makeRequest(''))
    const json = await res.json()

    expect(mockCompletionStream).not.toHaveBeenCalled()
    expect(json.relevance).toBe(0)
    // Empty-answer path predates G.3 and does not emit a status field.
    expect(json.status).toBeUndefined()
  })
})
