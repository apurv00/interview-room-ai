import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  aiLogger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { fetchWithRetry } from '@/lib/fetchWithRetry'
import { aiLogger } from '@/lib/logger'

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  it('returns true on first successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const result = await fetchWithRetry('/api/test', { method: 'PATCH' })
    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on network error and succeeds on 2nd attempt', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise

    expect(result).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('returns false after all retries exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' })
    await vi.advanceTimersByTimeAsync(1000) // 1st backoff
    await vi.advanceTimersByTimeAsync(2000) // 2nd backoff
    const result = await promise

    expect(result).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('logs warning when all retries exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(aiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/test', method: 'PATCH' }),
      'All fetch retries exhausted'
    )
  })

  it('retries on non-ok response', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise

    expect(result).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('respects custom maxRetries option', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('error')))

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' }, { maxRetries: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses exponential backoff delays', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('error'))
    vi.stubGlobal('fetch', fetchSpy)

    const promise = fetchWithRetry('/api/test', { method: 'PATCH' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // still waiting

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // 2nd attempt after 1s

    await vi.advanceTimersByTimeAsync(2000) // 2s backoff
    expect(fetchSpy).toHaveBeenCalledTimes(3)

    await promise
  })
})
