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
