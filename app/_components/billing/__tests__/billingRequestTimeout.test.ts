import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  billingFetch,
  BillingRequestTimeoutError,
} from '../billingRequestTimeout'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('billingFetch', () => {
  it('aborts and rejects a request that exceeds its deadline', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }))

    const request = billingFetch('/api/billing/profile', {}, 100)
    const rejection = expect(request).rejects.toBeInstanceOf(
      BillingRequestTimeoutError,
    )
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('propagates caller cancellation before the timeout', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })))

    const request = billingFetch(
      '/api/billing/quote',
      { signal: controller.signal },
      10_000,
    )
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
