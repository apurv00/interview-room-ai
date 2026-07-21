import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FeedbackAccountUnavailableError,
  fetchFeedbackSessionSummary,
} from '@feedback/lib/feedbackSessionFetcher'
import { _resetDeduplicatedFetchCache } from '@shared/cachedFetch'

describe('fetchFeedbackSessionSummary', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetDeduplicatedFetchCache()
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        _id: 'sess-1',
        status: 'completed',
        hasRecording: true,
        feedback: { overall_score: 78 },
      }),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('hits the expected /api/interviews/{id}?excludeTranscript=true URL', async () => {
    await fetchFeedbackSessionSummary('sess-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      '/api/interviews/sess-1?excludeTranscript=true',
    )
  })

  it('returns the parsed session summary on success', async () => {
    const out = await fetchFeedbackSessionSummary('sess-1')
    expect(out?.status).toBe('completed')
    expect(out?.hasRecording).toBe(true)
  })

  it('shares one network call across concurrent consumers (UAT-015 dedup)', async () => {
    const [a, b, c] = await Promise.all([
      fetchFeedbackSessionSummary('sess-1'),
      fetchFeedbackSessionSummary('sess-1'),
      fetchFeedbackSessionSummary('sess-1'),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a?.status).toBe('completed')
    expect(b?.status).toBe('completed')
    expect(c?.status).toBe('completed')
  })

  it('returns null on a non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
    const out = await fetchFeedbackSessionSummary('sess-bad')
    expect(out).toBeNull()
  })

  it('preserves only an exact inactive-account 401 as a typed terminal error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 'ACCOUNT_UNAVAILABLE' }),
    } as Response)

    await expect(fetchFeedbackSessionSummary('sess-deleting')).rejects.toBeInstanceOf(
      FeedbackAccountUnavailableError,
    )
  })

  it('continues treating an ordinary 401 as a generic miss', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 'SESSION_UNAVAILABLE' }),
    } as Response)

    await expect(fetchFeedbackSessionSummary('sess-unauthorized')).resolves.toBeNull()
  })

  it('returns null on network failure (non-abort)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    const out = await fetchFeedbackSessionSummary('sess-net')
    expect(out).toBeNull()
  })

  it('forwards the abort signal to fetch when provided', async () => {
    const ctrl = new AbortController()
    await fetchFeedbackSessionSummary('sess-1', { signal: ctrl.signal })
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined
    expect(init?.signal).toBe(ctrl.signal)
  })

  // ── Codex P1 (PR #402): abort semantics ─────────────────────────────────
  // Catching the abort and returning null silently collapsed it into a
  // "no data" miss — letting the feedback page's local-data fallback /
  // generateFeedback POST fire on an unmounting component. The helper
  // must rethrow AbortError so the existing
  // `if ((e as Error).name === 'AbortError') return` guards in the page
  // continue to short-circuit.

  it('rethrows AbortError so callers can short-circuit on unmount', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    fetchSpy.mockRejectedValueOnce(abortErr)
    await expect(fetchFeedbackSessionSummary('sess-abort')).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('still returns null for non-abort errors with similar shapes', async () => {
    // A timeout error (no `name: 'AbortError'`) is still a network error
    // and should land on the null-fallback path, NOT propagate.
    fetchSpy.mockRejectedValueOnce(new Error('timeout'))
    const out = await fetchFeedbackSessionSummary('sess-timeout')
    expect(out).toBeNull()
  })
})
