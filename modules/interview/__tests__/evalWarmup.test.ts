/**
 * Phase 1 — Q0 cold-start mitigation.
 *
 * Validates that /api/eval-warmup:
 *   1. Pre-populates the three caches that Q0's first /api/evaluate-answer
 *      call would otherwise miss synchronously (session config, JD context,
 *      resume context).
 *   2. Does NOT call the LLM router on its own response path (any LLM work
 *      is delegated to the cache loaders themselves, and on cache hit
 *      they never call the router).
 *   3. Degrades gracefully — session not found, missing JD/resume, or
 *      loader errors all return 200 so the interview never blocks on
 *      warming.
 *
 * Uses the passthrough composeApiRoute mock pattern from
 * evaluateAnswerTruncation.test.ts so the handler body runs without the
 * auth/rate-limit/Zod middleware chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockConnectDB,
  mockFindById,
  mockGetOrLoadSessionConfig,
  mockGetOrLoadJDContext,
  mockGetOrLoadResumeContext,
  mockCompletion,
  mockCompletionStream,
  mockWarn,
  mockError,
  mockInfo,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockFindById: vi.fn(),
  mockGetOrLoadSessionConfig: vi.fn(),
  mockGetOrLoadJDContext: vi.fn(),
  mockGetOrLoadResumeContext: vi.fn(),
  mockCompletion: vi.fn(),
  mockCompletionStream: vi.fn(),
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
      user: { id: 'test-user-1', role: 'candidate', plan: 'free', email: 't@example.com' },
      body,
      params: {},
    })
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mockConnectDB,
  connectDBIfNeeded: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}))

vi.mock('@interview/services/core/sessionConfigCache', () => ({
  getOrLoadSessionConfig: mockGetOrLoadSessionConfig,
}))

vi.mock('@interview/services/persona/documentContextCache', () => ({
  getOrLoadJDContext: mockGetOrLoadJDContext,
  getOrLoadResumeContext: mockGetOrLoadResumeContext,
}))

// If the route ever accidentally calls the model router, these spies fail
// the "no LLM on response path" assertion below.
vi.mock('@shared/services/modelRouter', () => ({
  completion: mockCompletion,
  completionStream: mockCompletionStream,
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: mockWarn, error: mockError, info: mockInfo, debug: vi.fn() },
  logger: { warn: mockWarn, error: mockError, info: mockInfo, debug: vi.fn() },
}))

// Chainable findById().select().lean() helper.
function mockSessionDoc(doc: unknown) {
  mockFindById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(doc) }),
  })
}

async function callRoute(body: unknown) {
  const { POST } = await import('@/app/api/eval-warmup/route')
  const req = new NextRequest('http://test.local/api/eval-warmup', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('/api/eval-warmup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnectDB.mockResolvedValue(undefined)
    mockGetOrLoadSessionConfig.mockResolvedValue({ domain: null, depth: null, rubric: null, userProfile: null, parsedJD: null })
    mockGetOrLoadJDContext.mockResolvedValue('jd-summary')
    mockGetOrLoadResumeContext.mockResolvedValue('resume-summary')
  })

  it('warms all three caches when session has JD and resume', async () => {
    mockSessionDoc({
      userId: { toString: () => 'test-user-1' },
      config: { role: 'sdet', interviewType: 'behavioral', experience: '0-2' },
      jobDescription: 'A QA engineer role at Trustmore...',
      resumeText: 'Rakshit — Quality Assurance Engineer...',
    })

    const { status, json } = await callRoute({ sessionId: 'sess-1' })

    expect(status).toBe(200)
    expect(json.warmed).toBe(true)
    expect(json.components).toEqual({ config: 'ok', jd: 'ok', resume: 'ok' })
    expect(mockConnectDB).toHaveBeenCalledTimes(1)
    expect(mockGetOrLoadSessionConfig).toHaveBeenCalledWith('sess-1', {
      role: 'sdet',
      interviewType: 'behavioral',
      userId: 'test-user-1',
      experience: '0-2',
    })
    expect(mockGetOrLoadJDContext).toHaveBeenCalledWith('sess-1', 'A QA engineer role at Trustmore...')
    expect(mockGetOrLoadResumeContext).toHaveBeenCalledWith(
      'sess-1',
      'Rakshit — Quality Assurance Engineer...',
      'sdet',
    )
  })

  it('returns 403 when the caller is not the session owner (Codex P1 fix)', async () => {
    // Session owned by a different user; mocked auth user is 'test-user-1'.
    mockSessionDoc({
      userId: { toString: () => 'someone-else-456' },
      config: { role: 'sdet', interviewType: 'behavioral', experience: '0-2' },
      jobDescription: 'private JD',
      resumeText: 'private resume',
    })

    const { status, json } = await callRoute({ sessionId: 'sess-victim' })

    expect(status).toBe(403)
    expect(json.warmed).toBe(false)
    expect(json.reason).toBe('forbidden')
    // Critical: no doc-context loaders fired for the unauthorized session.
    expect(mockGetOrLoadSessionConfig).not.toHaveBeenCalled()
    expect(mockGetOrLoadJDContext).not.toHaveBeenCalled()
    expect(mockGetOrLoadResumeContext).not.toHaveBeenCalled()
  })

  it('does NOT call the LLM router on its response path', async () => {
    mockSessionDoc({
      userId: { toString: () => 'test-user-1' },
      config: { role: 'sdet', interviewType: 'behavioral', experience: '0-2' },
      jobDescription: 'jd',
      resumeText: 'resume',
    })

    await callRoute({ sessionId: 'sess-1' })

    // The route itself must never call modelRouter directly. (Cache loaders
    // may fire LLM calls internally on miss, but those are mocked here.)
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockCompletionStream).not.toHaveBeenCalled()
  })

  it('skips JD and resume warms when the session has neither', async () => {
    mockSessionDoc({
      userId: { toString: () => 'test-user-1' },
      config: { role: 'sdet', interviewType: 'behavioral', experience: '0-2' },
    })

    const { status, json } = await callRoute({ sessionId: 'sess-1' })

    expect(status).toBe(200)
    expect(json.warmed).toBe(true)
    expect(json.components).toEqual({ config: 'ok', jd: 'skipped', resume: 'skipped' })
    expect(mockGetOrLoadJDContext).not.toHaveBeenCalled()
    expect(mockGetOrLoadResumeContext).not.toHaveBeenCalled()
  })

  it('returns warmed=false when the session is not found', async () => {
    mockSessionDoc(null)

    const { status, json } = await callRoute({ sessionId: 'nonexistent' })

    expect(status).toBe(200)
    expect(json.warmed).toBe(false)
    expect(mockGetOrLoadSessionConfig).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalled()
  })

  it('marks the failing component as error but still returns 200', async () => {
    mockSessionDoc({
      userId: { toString: () => 'test-user-1' },
      config: { role: 'sdet', interviewType: 'behavioral', experience: '0-2' },
      jobDescription: 'jd',
      resumeText: 'resume',
    })
    mockGetOrLoadJDContext.mockRejectedValueOnce(new Error('LLM blew up'))

    const { status, json } = await callRoute({ sessionId: 'sess-1' })

    expect(status).toBe(200)
    expect(json.warmed).toBe(true)
    expect((json.components as Record<string, string>).jd).toBe('error')
    expect((json.components as Record<string, string>).config).toBe('ok')
    expect((json.components as Record<string, string>).resume).toBe('ok')
  })

  it('swallows unexpected errors and still returns 200', async () => {
    mockConnectDB.mockRejectedValueOnce(new Error('Atlas down'))

    const { status, json } = await callRoute({ sessionId: 'sess-1' })

    expect(status).toBe(200)
    expect(json.warmed).toBe(false)
    expect(mockWarn).toHaveBeenCalled()
  })
})
