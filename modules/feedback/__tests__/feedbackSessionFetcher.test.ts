import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchFeedbackSessionSummary } from '@feedback/lib/feedbackSessionFetcher'

describe('fetchFeedbackSessionSummary', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
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

  it('returns null on network failure', async () => {
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
})
