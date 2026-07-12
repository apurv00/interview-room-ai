import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchJSONWithRetry } from '@shared/fetchJSONWithRetry'

vi.mock('@shared/logger', () => ({ aiLogger: { warn: vi.fn() } }))

describe('fetchJSONWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ hello: 'world' }),
    }))
    const r = await fetchJSONWithRetry<{ hello: string }>('https://x.test/a')
    expect(r).toEqual({ ok: true, data: { hello: 'world' }, status: 200 })
  })

  it('does NOT retry non-429 4xx — a 404 is an answer (board liveness)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', f)
    const r = await fetchJSONWithRetry('https://x.test/a')
    expect(r).toEqual({ ok: false, status: 404, error: 'http-404' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries 5xx up to maxRetries', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) })
    vi.stubGlobal('fetch', f)
    const r = await fetchJSONWithRetry('https://x.test/a', {}, { baseDelayMs: 1 })
    expect(r.ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('[Cx-507] a pre-aborted caller signal short-circuits — fetch never fires', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const ac = new AbortController()
    ac.abort()
    const r = await fetchJSONWithRetry('https://x.test/a', { signal: ac.signal })
    expect(r).toEqual({ ok: false, status: 0, error: 'aborted' })
    expect(f).not.toHaveBeenCalled()
  })

  it('[Cx-507] a mid-flight caller abort kills the request AND the retry sequence', async () => {
    const ac = new AbortController()
    const f = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        })
        // Abort the CALLER's controller while the request is in flight —
        // the composed per-attempt controller must relay it.
        queueMicrotask(() => ac.abort())
      })
    )
    vi.stubGlobal('fetch', f)
    const r = await fetchJSONWithRetry('https://x.test/a', { signal: ac.signal }, { baseDelayMs: 1 })
    expect(r).toEqual({ ok: false, status: 0, error: 'aborted' })
    expect(f).toHaveBeenCalledTimes(1) // no retry after caller abort
  })

  it('[Cx-507] a caller abort during the retry BACKOFF settles immediately', async () => {
    // One retryable failure puts the helper into a long exponential sleep;
    // aborting mid-backoff must resolve 'aborted' now, not after the delay.
    const ac = new AbortController()
    const f = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', f)
    const started = Date.now()
    setTimeout(() => ac.abort(), 10)
    const r = await fetchJSONWithRetry('https://x.test/a', { signal: ac.signal }, { baseDelayMs: 60000 })
    expect(r).toEqual({ ok: false, status: 503, error: 'aborted' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(5000) // nowhere near the 60s backoff
  })

  it('[Cx-507] the helper timeout still reads as timeout, not aborted', async () => {
    const f = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    )
    vi.stubGlobal('fetch', f)
    const r = await fetchJSONWithRetry('https://x.test/a', {}, { maxRetries: 1, timeoutMs: 5 })
    expect(r).toEqual({ ok: false, status: 0, error: 'timeout' })
  })
})
