/**
 * Tests for POST /api/learn/drill/evaluate (SSE).
 *
 * The route always streams (no feature-flag gate). Streaming engages
 * automatically because the default provider for `learn.drill-evaluate`
 * is OpenAI (which has a native `.stream` adapter). Anthropic + other
 * providers polyfill via `complete()`-as-single-delta.
 *
 * Covers:
 *   - Response shape: `text/event-stream` + no-cache + X-Accel-Buffering:no
 *   - Per-dim `event: score` frames emit exactly once even across
 *     multi-chunk deltas
 *   - Fence-wrapped JSON (```json prefix) parses correctly
 *   - `event: complete` includes newScore + delta + breakdown
 *   - `saveDrillAttempt` failure still emits `complete` with
 *     `persistFailed: true`
 *   - Codex P1 isFourDimScore guard: malformed scores (NaN, out-of-range)
 *     fail the shape check and emit `event: error` instead of corrupting
 *     DrillAttempt.breakdown
 *   - Final JSON parse failure emits `event: error`
 *   - Unauth → 401; missing fields → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetServerSession,
  mockStreamCompletion,
  mockSaveDrillAttempt,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockStreamCompletion: vi.fn(),
  mockSaveDrillAttempt: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...a: unknown[]) => mockGetServerSession(...a),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/services/modelRouter', () => ({
  streamCompletion: (...a: unknown[]) => mockStreamCompletion(...a),
}))
vi.mock('@shared/services/promptSecurity', () => ({
  JSON_OUTPUT_RULE: 'Respond with ONLY valid JSON.',
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
  mockSaveDrillAttempt.mockReset()
  mockSaveDrillAttempt.mockResolvedValue({
    questionIndex: 0,
    question: 'q',
    originalScore: 40,
    newScore: 70,
    delta: 30,
    breakdown: { relevance: 80, structure: 65, specificity: 65, ownership: 70 },
  })
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

describe('POST /api/learn/drill/evaluate', () => {
  it('returns text/event-stream with no-cache and X-Accel-Buffering:no', async () => {
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
    expect(scoreFrames).toHaveLength(4)
    const dims = scoreFrames.map((f) => JSON.parse(f.data).dimension as string).sort()
    expect(dims).toEqual(['ownership', 'relevance', 'specificity', 'structure'])
    for (const f of scoreFrames) {
      const { dimension, score } = JSON.parse(f.data)
      expect(typeof score).toBe('number')
      if (dimension === 'relevance') expect(score).toBe(80)
      if (dimension === 'structure') expect(score).toBe(65)
      if (dimension === 'ownership') expect(score).toBe(70)
    }
  })

  it('does not emit partial digits when a number splits across deltas (Codex P2)', async () => {
    // Streaming model emits the relevance value 65 in two chunks
    // (`6` then `5,...`). Without a terminator-lookahead, the regex
    // would match `6` on the first chunk, emit it, mark `relevance`
    // as already-emitted, and never correct to 65 — the user sees a
    // wrong per-dim value. With the lookahead, `6` is rejected (no
    // terminator yet); after the next chunk lands, `65,` matches
    // cleanly.
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":6' },
        { kind: 'delta', text: '5,"structure":7' },
        { kind: 'delta', text: '0,"specificity":8' },
        { kind: 'delta', text: '5,"ownership":9' },
        { kind: 'delta', text: '0}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    const scoreFrames = frames.filter((f) => f.event === 'score')
    // Exactly 4 score events, each carrying the FULL final number,
    // not a leading-digit prefix.
    expect(scoreFrames).toHaveLength(4)
    const scoresByDim = Object.fromEntries(
      scoreFrames.map((f) => {
        const p = JSON.parse(f.data)
        return [p.dimension, p.score]
      }),
    )
    expect(scoresByDim).toEqual({
      relevance: 65,
      structure: 70,
      specificity: 85,
      ownership: 90,
    })
  })

  it('parses fence-wrapped JSON when chunks include ```json prefix', async () => {
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
    expect(payload.newScore).toBe(70)
  })

  it('emits event: error when final JSON parse fails', async () => {
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

  // Codex P1 protection — preserved from the old sync route.test.ts.
  // Malformed scores must NOT reach DrillAttempt.breakdown (which has
  // min: 0, max: 100 mongoose validation). In the streaming branch
  // this manifests as `event: error` instead of the old "silent drop
  // breakdown + 200" — saveDrillAttempt is never called with bad data.
  it('rejects NaN scores with event: error and does not call saveDrillAttempt', async () => {
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        // JSON.stringify drops NaN to null, so simulate the parsed
        // shape directly via a JSON literal that produces NaN-equivalent.
        { kind: 'delta', text: '{"relevance":80,"structure":65,"specificity":null,"ownership":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    expect(mockSaveDrillAttempt).not.toHaveBeenCalled()
  })

  it('rejects out-of-range scores (>100) with event: error', async () => {
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":105,"structure":65,"specificity":65,"ownership":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    expect(mockSaveDrillAttempt).not.toHaveBeenCalled()
  })

  it('rejects out-of-range scores (<0) with event: error', async () => {
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":80,"structure":-5,"specificity":65,"ownership":70}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    expect(mockSaveDrillAttempt).not.toHaveBeenCalled()
  })

  it('rejects missing dimension with event: error', async () => {
    mockStreamCompletion.mockReturnValue(
      asyncIterFrom([
        { kind: 'delta', text: '{"relevance":80,"structure":65,"specificity":65}' },
        { kind: 'done', inputTokens: 50, outputTokens: 30, truncated: false },
      ]),
    )

    const res = await POST(buildRequest(baseBody))
    const frames = await collectSSEFrames(res)
    expect(frames.some((f) => f.event === 'error')).toBe(true)
    expect(mockSaveDrillAttempt).not.toHaveBeenCalled()
  })

  it('401s when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await POST(buildRequest(baseBody))
    expect(res.status).toBe(401)
  })

  it('400s when required fields are missing', async () => {
    const res = await POST(
      buildRequest({ sessionId: '507f1f77bcf86cd799439001' }),
    )
    expect(res.status).toBe(400)
  })
})
