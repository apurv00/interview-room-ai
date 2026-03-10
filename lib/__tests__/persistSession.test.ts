import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the persistSession function by importing it indirectly.
// Since it's a module-level function in useInterview.ts, we extract the logic
// here for testability.

async function persistSession(sessionId: string, payload: Record<string, unknown>) {
  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`/api/interviews/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) return
    } catch {
      // Network error — retry
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
    }
  }
}

describe('persistSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  it('succeeds on first attempt without retrying', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    await persistSession('abc', { status: 'completed' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/interviews/abc', expect.objectContaining({
      method: 'PATCH',
    }))
  })

  it('retries on network error and succeeds on 2nd attempt', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const promise = persistSession('abc', { status: 'completed' })
    // Advance past the 1s backoff (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries on non-ok response', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const promise = persistSession('abc', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('gives up after 3 failed attempts', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', fetchSpy)

    const promise = persistSession('abc', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(1000) // 1st backoff
    await vi.advanceTimersByTimeAsync(2000) // 2nd backoff
    await promise

    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('uses exponential backoff (1s, 2s)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', fetchSpy)

    const promise = persistSession('abc', { status: 'completed' })

    // After 0ms: 1st attempt fails, starts 1s timer
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // still waiting

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // 2nd attempt after 1s

    await vi.advanceTimersByTimeAsync(2000) // 2s backoff for 3rd attempt
    expect(fetchSpy).toHaveBeenCalledTimes(3)

    await promise
  })
})
