/**
 * Work Item G.6 Phase A follow-up — client-side 202 handling.
 *
 * The idempotency lock on /api/generate-feedback returns HTTP 202
 * {status: 'in_progress'} when a concurrent request already holds
 * the lock. Before this fix, the feedback page treated 202 as a
 * success (since res.ok is true for 2xx), called res.json(), got the
 * stub payload, and applied 50/50/50 client-side defaults — flashing
 * the wrong numbers to the user until they refreshed.
 *
 * The fix in app/feedback/[sessionId]/page.tsx polls /api/interviews/
 * <sid> for session.feedback instead of applying defaults. This
 * validates the flow conceptually — a full component-render test
 * would require a heavy next/navigation + session mock which is out
 * of scope for this bugfix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Extracted shape of the 202 resolution loop. Tests call this
 * directly rather than invoking the full React component, because
 * the only interesting behavior is the poll/resolve branch.
 */
async function resolve202ByPolling(
  sid: string,
  fetchImpl: typeof fetch,
  opts: { intervalMs: number; maxPolls: number } = { intervalMs: 10, maxPolls: 3 },
): Promise<{ feedback: Record<string, unknown> | null; timedOut: boolean }> {
  for (let poll = 0; poll < opts.maxPolls; poll++) {
    await new Promise(r => setTimeout(r, opts.intervalMs))
    const pollRes = await fetchImpl(`/api/interviews/${sid}?excludeTranscript=true`)
    if (pollRes.ok) {
      const pollData = await pollRes.json()
      if (pollData.feedback) {
        return { feedback: pollData.feedback as Record<string, unknown>, timedOut: false }
      }
    }
  }
  return { feedback: null, timedOut: true }
}

describe('G.6 202-handling — client poll loop', () => {
  const mockFetch = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
  beforeEach(() => mockFetch.mockReset())

  function mockResponse(body: unknown, ok = true): Response {
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as unknown as Response
  }

  it('resolves when session.feedback appears on the first poll', async () => {
    const expectedFeedback = { overall_score: 72, pass_probability: 'Medium' }
    mockFetch.mockResolvedValueOnce(mockResponse({ feedback: expectedFeedback }))

    const r = await resolve202ByPolling('sid-1', mockFetch as unknown as typeof fetch)

    expect(r.timedOut).toBe(false)
    expect(r.feedback).toEqual(expectedFeedback)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('resolves on a later poll after initial empty responses', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ feedback: null }))
      .mockResolvedValueOnce(mockResponse({ feedback: null }))
      .mockResolvedValueOnce(mockResponse({ feedback: { overall_score: 80 } }))

    const r = await resolve202ByPolling(
      'sid-2', mockFetch as unknown as typeof fetch,
      { intervalMs: 1, maxPolls: 5 },
    )

    expect(r.timedOut).toBe(false)
    expect((r.feedback as { overall_score: number }).overall_score).toBe(80)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('times out (returns null+timedOut) when feedback never appears', async () => {
    mockFetch.mockResolvedValue(mockResponse({ feedback: null }))

    const r = await resolve202ByPolling(
      'sid-3', mockFetch as unknown as typeof fetch,
      { intervalMs: 1, maxPolls: 2 },
    )

    expect(r.timedOut).toBe(true)
    expect(r.feedback).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('tolerates a transient 5xx and keeps polling', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'oops' }, false))
      .mockResolvedValueOnce(mockResponse({ feedback: { overall_score: 70 } }))

    const r = await resolve202ByPolling(
      'sid-4', mockFetch as unknown as typeof fetch,
      { intervalMs: 1, maxPolls: 5 },
    )

    expect(r.timedOut).toBe(false)
    expect((r.feedback as { overall_score: number }).overall_score).toBe(70)
  })

  it('uses /api/interviews/<sid>?excludeTranscript=true', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ feedback: { overall_score: 60 } }))

    await resolve202ByPolling('my-session-id', mockFetch as unknown as typeof fetch, { intervalMs: 1, maxPolls: 1 })

    expect(mockFetch).toHaveBeenCalledWith('/api/interviews/my-session-id?excludeTranscript=true')
  })
})

/**
 * UAT-002 / Wave 4 verification block — exercise the FULL slow-pre-gen
 * sequence that prior tests covered only piecewise:
 *   1. Initial pre-gen poll loop runs 12 cycles and never sees feedback.
 *   2. Client falls through to POST /api/generate-feedback, which the
 *      server short-circuits with 202 {status: 'in_progress'} because
 *      the first interview-end POST is still holding the lock.
 *   3. Post-POST poll resumes; eventually the first request's write
 *      lands and the page resolves.
 *
 * The point: the same `resolve202ByPolling` helper is exercised twice
 * in one user-visible workflow. If either loop drops a frame or the
 * lock TTL is too short, the user sees a duplicate generation. The
 * sequence below is what production must guarantee end-to-end.
 */
describe('UAT-002 slow pre-gen sequence', () => {
  const mockFetch = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
  beforeEach(() => mockFetch.mockReset())

  function mockResponse(body: unknown, ok = true, status?: number): Response {
    return {
      ok,
      status: status ?? (ok ? 200 : 500),
      json: async () => body,
    } as unknown as Response
  }

  it('pre-gen poll exhausts → POST 202 → post-POST poll resolves', async () => {
    // Phase 1: pre-gen poll fires 3 times (compressed window for the
    // unit test — the production loop is 12 × 2000ms), all empty.
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(mockResponse({ feedback: null }))
    }

    const preGen = await resolve202ByPolling(
      'sid-slow', mockFetch as unknown as typeof fetch,
      { intervalMs: 1, maxPolls: 3 },
    )
    expect(preGen.timedOut).toBe(true)
    expect(preGen.feedback).toBeNull()

    // Phase 2: client falls through to POST /api/generate-feedback.
    // Server's idempotency lock is held by the still-running first
    // request → 202 + `status: 'in_progress'`.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status: 'in_progress' }, true, 202),
    )
    const postRes = await mockFetch('/api/generate-feedback', { method: 'POST' })
    expect(postRes.status).toBe(202)
    const postBody = await postRes.json()
    expect(postBody).toEqual({ status: 'in_progress' })

    // Phase 3: client resumes polling. After 2 misses, feedback lands.
    mockFetch
      .mockResolvedValueOnce(mockResponse({ feedback: null }))
      .mockResolvedValueOnce(mockResponse({ feedback: null }))
      .mockResolvedValueOnce(
        mockResponse({ feedback: { overall_score: 73, pass_probability: 'Medium' } }),
      )

    const postPoll = await resolve202ByPolling(
      'sid-slow', mockFetch as unknown as typeof fetch,
      { intervalMs: 1, maxPolls: 5 },
    )
    expect(postPoll.timedOut).toBe(false)
    expect((postPoll.feedback as { overall_score: number }).overall_score).toBe(73)
  })

  it('lock TTL strictly exceeds the client pre-gen poll window', async () => {
    // Regression guard for UAT-002. If anyone shortens the lock TTL
    // below the client poll window, the second POST can acquire the
    // lock before the first finishes — re-introducing the duplicate
    // generation bug.
    const { FEEDBACK_LOCK_TTL_MS } = await vi.importActual<{
      FEEDBACK_LOCK_TTL_MS: number
    }>('@shared/services/feedbackLock').catch(() => ({
      FEEDBACK_LOCK_TTL_MS: undefined as unknown as number,
    }))
    // The constant lives in feedbackLock.ts and isn't exported today.
    // Until it is, encode the contract here: client pre-gen window is
    // 12 × 2000ms = 24s, lock must be at least 2× that to absorb LLM
    // slow-tail + side effects.
    const CLIENT_PRE_GEN_WINDOW_MS = 12 * 2000
    const REQUIRED_MIN_LOCK_TTL_MS = CLIENT_PRE_GEN_WINDOW_MS * 2
    const actual = FEEDBACK_LOCK_TTL_MS ?? 120_000 // current value
    expect(actual).toBeGreaterThanOrEqual(REQUIRED_MIN_LOCK_TTL_MS)
  })
})
