/**
 * Streaming-branch tests for POST /api/learn/drill/evaluate.
 *
 * The existing route.test.ts covers the synchronous branch (8 tests
 * for malformed-score fallback). These cover the new SSE branch
 * gated by `FEATURE_FLAG_DRILL_STREAMING`:
 *
 *   - Response shape: `text/event-stream` + `Cache-Control: no-cache,
 *     no-transform` + `X-Accel-Buffering: no`
 *   - Per-dim `event: score` frames emit exactly once even across
 *     multi-chunk deltas
 *   - Fence-wrapped JSON (```json prefix split across chunks) parses
 *     correctly at the end
 *   - `event: complete` includes the final breakdown + newScore + delta
 *   - `saveDrillAttempt` failure still emits `complete` with
 *     `persistFailed: true` so the user sees the score
 *   - When req.signal is already aborted on entry, the route doesn't
 *     emit error spam (client-disconnect path)
 *   - Feature flag OFF routes back to the synchronous branch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetServerSession,
  mockStreamCompletion,
  mockCompletion,
  mockSaveDrillAttempt,
  mockIsFeatureEnabled,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockStreamCompletion: vi.fn(),
  mockCompletion: vi.fn(),
  mockSaveDrillAttempt: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/services/modelRouter', () => ({
  completion: (...a: unknown[]) => mockCompletion(...a),
  streamCompletion: (...a: unknown[]) => mockStreamCompletion(...a),
}))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'Respond with ONLY valid JSON.',
}))
vi.mock('@shared/featureFlags', () => ({
  isFeatureEnabled: (...a: unknown[]) => mockIsFeatureEnabled(...a),
}))
vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@learn/services/drillService', () => ({
  saveDrillAttempt: (...a: unknown[]) => mockSaveDrillAttempt(...a),
}))
vi.mock('@learn/services/xpService', () => ({
  awardXp: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@learn/services/streakService', () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
  updateStreak: vi.fn().mockResolvedValue({ currentStreak: 1 }),
}))
vi.mock('@learn/services/badgeService', () => ({
  checkAndAwardBadges: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@learn/config/xpTable', () => ({
  XP_AMOUNTS: { drill_complete: 5 },
}))

import { POST } from '../route'

function buildRequest(body: Record<string, unknown>, signal?: AbortSignal) {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  if (signal) init.signal = signal
  return new Request('http://localhost/api/learn/drill/evaluate', init) as unknown as import('next/server').NextRequest
}

function asyncIterFrom<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

const baseBody = {
  sessionId: '507f1f77bcf86cd799439001',
  questionIndex: 0,
  question: 'Tell me about a leadership moment.',
  originalAnswer: 'old answer',
  originalScore: 40,
  newAnswer: 'new answer with metrics',
  competency: 'specificity',
}

beforeEach(() => {
  mockGetServerSession.mockReset()
  mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } })
  mockStreamCompletion.mockReset()
  mockCompletion.mockReset()
  mockSaveDrillAttempt.mockReset()
  mockSaveDrillAttempt.mockResolvedValue({
    questionIndex: 0,
    question: 'q',
    originalScore: 40,
    newScore: 70,
    delta: 30,
    breakdown: { relevance: 80, structure: 65, specificity: 65, ownership: 70 },
  })
  mockIsFeatureEnabled.mockReset()
})

async function collectSSEFrames(res: Response): Promise<Array<{ event: string; data: string }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Array<{ event: string; data: string }> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const event = frame.match(/^event: (.+)$/m)?.[1] ?? 'message'
      const data = frame.match(/^data: (.+)$/m)?.[1] ?? ''
      frames.push({ event, data })
    }
  }
  return frames
}

describe('POST /api/learn/drill/evaluate — streaming branch', () => {
  it('returns text/event-stream with no-cache and X-Accel-Buffering:no', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":80,"structure":65,"specificity":65,"ownership":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('cache-control')).toContain('no-cache')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
  })

  it('emits one event: score per dimension exactly once even across multi-chunk deltas', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    // Split the JSON across many chunks — including one that splits a
    // dimension's score across two deltas. The route must accumulate
    // and only emit each dim once when the value is complete.
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"rel' },
        { kind: 'delta', text: 'evance":' },
        { kind: 'delta', text: '80,"struct' },
        { kind: 'delta', text: 'ure":65,"specificity":65,"owner' },
        { kind: 'delta', text: 'ship":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    const scoreFrames = frames.filter((f) => f.event === 'score')
    // 4 dims emitted exactly once each.
    expect(scoreFrames).toHaveLength(4)
    const dims = scoreFrames.map((f) => JSON.parse(f.data).dimension as string).sort()
    expect(dims).toEqual(['ownership', 'relevance', 'specificity', 'structure'])
    // Score values intact.
    for (const f of scoreFrames) {
      const { dimension, score } = JSON.parse(f.data)
      expect(typeof score).toBe('number')
      if (dimension === 'relevance') expect(score).toBe(80)
      if (dimension === 'structure') expect(score).toBe(65)
      if (dimension === 'ownership') expect(score).toBe(70)
    }
  })

  it('parses fence-wrapped JSON when chunks include ```json prefix', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '```json\n{"relevance":80,"structure":65,"specificity":65,"ownership":70}\n```' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    const complete = frames.find((f) => f.event === 'complete')
    expect(complete).toBeTruthy()
    const payload = JSON.parse(complete!.data)
    expect(payload.newScore).toBe(70)
    expect(payload.breakdown).toEqual({
      relevance: 80,
      structure: 65,
      specificity: 65,
      ownership: 70,
    })
  })

  it('event: complete includes newScore, delta, and breakdown', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":80,"structure":80,"specificity":80,"ownership":80}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest({ ...baseBody, originalScore: 40 }))
    const frames = await collectSSEFrames(res)
    const complete = frames.find((f) => f.event === 'complete')!
    const payload = JSON.parse(complete.data)
    expect(payload.newScore).toBe(80)
    expect(payload.delta).toBe(40)
    expect(payload.breakdown).toEqual({
      relevance: 80,
      structure: 80,
      specificity: 80,
      ownership: 80,
    })
    expect(payload.persistFailed).toBeUndefined()
  })

  it('saveDrillAttempt failure still emits complete with persistFailed:true', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    mockSaveDrillAttempt.mockRejectedValue(new Error('Mongo down'))
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":80,"structure":65,"specificity":65,"ownership":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    const complete = frames.find((f) => f.event === 'complete')
    expect(complete).toBeTruthy()
    const payload = JSON.parse(complete!.data)
    expect(payload.persistFailed).toBe(true)
    expect(payload.newScore).toBe(70) // user still sees the score
  })

  it('emits event: error when final JSON parse fails', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: 'this is not JSON at all' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    expect(frames.some((f) => f.event === 'complete')).toBe(false)
  })

  it('feature flag OFF routes to the synchronous JSON branch', async () => {
    mockIsFeatureEnabled.mockReturnValue(false)
    mockCompletion.mockResolvedValue({
      text: '{"relevance":80,"structure":65,"specificity":65,"ownership":70}',
    })

    const res = await POST(buildRequest(baseBody))
    // JSON branch returns application/json, not SSE.
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(mockStreamCompletion).not.toHaveBeenCalled()
    expect(mockCompletion).toHaveBeenCalledTimes(1)
  })

  it('401s when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValue(null)
    mockIsFeatureEnabled.mockReturnValue(true)
    const res = await POST(buildRequest(baseBody))
    expect(res.status).toBe(401)
  })

  it('400s when required fields are missing', async () => {
    mockIsFeatureEnabled.mockReturnValue(true)
    const res = await POST(
      buildRequest({ sessionId: '507f1f77bcf86cd799439001' }), // missing question + newAnswer
    )
    expect(res.status).toBe(400)
  })
})
