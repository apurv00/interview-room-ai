import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  deduplicatedFetch,
  deduplicatedFetchJSON,
  _resetDeduplicatedFetchCache,
} from '@shared/cachedFetch'

describe('deduplicatedFetchJSON', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetDeduplicatedFetchCache()
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('coalesces concurrent signal-less GETs to the same URL', async () => {
    const [a, b, c] = await Promise.all([
      deduplicatedFetchJSON('/x'),
      deduplicatedFetchJSON('/x'),
      deduplicatedFetchJSON('/x'),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(c).toEqual({ ok: true })
  })

  it('uses cacheKey when provided to separate auth-scoped callers', async () => {
    await Promise.all([
      deduplicatedFetchJSON('/x', undefined, '/x#userA'),
      deduplicatedFetchJSON('/x', undefined, '/x#userB'),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // ── PR #402 follow-up: signal-bearing callers bypass the shared cache ──
  // A shared promise is bound to the FIRST caller's signal-or-lack-thereof.
  // A second caller passing its own signal would either inherit the
  // first's abort (unasked-for cancellation) or lose the ability to
  // abort (signal does nothing). Each signal-bearing call gets its
  // own fetch so abort semantics stay per-caller.

  it('bypasses the dedup cache when the caller passes an AbortSignal', async () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    await Promise.all([
      deduplicatedFetchJSON('/x', { signal: c1.signal }),
      deduplicatedFetchJSON('/x', { signal: c2.signal }),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('mixed signal-less + signal-bearing: signal-less coalesce, signal-bearing run alone', async () => {
    const ctrl = new AbortController()
    await Promise.all([
      deduplicatedFetchJSON('/x'),
      deduplicatedFetchJSON('/x'),
      deduplicatedFetchJSON('/x', { signal: ctrl.signal }),
    ])
    // 2 signal-less calls coalesce → 1 fetch. 1 signal-bearing → 1 fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT propagate a signal-bearing caller\'s abort to signal-less callers', async () => {
    // Hold the first signal-less fetch open so we can verify it survives
    // a sibling signal-bearing caller's abort.
    let resolveShared: (r: Response) => void = () => {}
    fetchSpy.mockReturnValueOnce(
      new Promise<Response>((r) => { resolveShared = r }),
    )
    // Second mock for the signal-bearing call.
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    fetchSpy.mockRejectedValueOnce(abortErr)

    const sharedPromise = deduplicatedFetchJSON('/y')
    const ctrl = new AbortController()
    const abortedPromise = deduplicatedFetchJSON('/y', { signal: ctrl.signal })

    // The signal-bearing call rejects on its own.
    await expect(abortedPromise).rejects.toMatchObject({ name: 'AbortError' })

    // The signal-less call is unaffected; resolve it manually.
    resolveShared({ ok: true, json: async () => ({ survived: true }) } as Response)
    expect(await sharedPromise).toEqual({ survived: true })
  })
})

describe('deduplicatedFetch (Response variant)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetDeduplicatedFetchCache()
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('also bypasses sharing when the caller passes an AbortSignal', async () => {
    const ctrl = new AbortController()
    await Promise.all([
      deduplicatedFetch('/z'),
      deduplicatedFetch('/z', { signal: ctrl.signal }),
    ])
    // One signal-less → cache hit; one signal-bearing → its own fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
