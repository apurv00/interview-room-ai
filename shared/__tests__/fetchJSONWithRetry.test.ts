import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinnedHttpClient, type PinnedHttpResult } from '@shared/pinnedHttpClient'
import { fetchJSONWithRetry } from '@shared/fetchJSONWithRetry'

vi.mock('@shared/logger', () => ({ aiLogger: { warn: vi.fn() } }))

const publicAnswer = { address: '93.184.216.34', family: 4 as const }
const wireJSON = (status: number, value: unknown, socketAttempts = 1): PinnedHttpResult => ({
  kind: 'response',
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(value)),
  socketAttempts,
})

describe('fetchJSONWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns parsed JSON on success', async () => {
    const requestImpl = vi.fn().mockResolvedValue(wireJSON(200, { hello: 'world' }))
    const result = await fetchJSONWithRetry<{ hello: string }>(
      'https://provider.test/a',
      {},
      { requestImpl },
    )
    expect(result).toEqual({ ok: true, data: { hello: 'world' }, status: 200, attempts: 1 })
  })

  it('treats malformed 2xx JSON as terminal', async () => {
    const requestImpl = vi.fn().mockResolvedValue({
      kind: 'response',
      status: 200,
      headers: {},
      body: Buffer.from('<html>'),
      socketAttempts: 1,
    } satisfies PinnedHttpResult)

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      baseDelayMs: 1,
      requestImpl,
    })

    expect(result).toEqual({ ok: false, status: 200, error: 'invalid JSON body', attempts: 1 })
    expect(requestImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a transient pinned network failure', async () => {
    const requestImpl = vi.fn()
      .mockResolvedValueOnce({
        kind: 'network-error',
        code: 'ECONNRESET',
        retryable: true,
        socketAttempts: 1,
      } satisfies PinnedHttpResult)
      .mockResolvedValueOnce(wireJSON(200, { recovered: true }))

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      baseDelayMs: 1,
      requestImpl,
    })

    expect(result).toEqual({ ok: true, data: { recovered: true }, status: 200, attempts: 2 })
    expect(requestImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a terminal 4xx or redirect response', async () => {
    for (const status of [302, 404]) {
      const requestImpl = vi.fn().mockResolvedValue(wireJSON(status, {}))
      const result = await fetchJSONWithRetry('https://provider.test/a', {}, { requestImpl })
      expect(result).toEqual({ ok: false, status, error: `http-${status}`, attempts: 1 })
      expect(requestImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('retries 5xx up to the configured resolution cycles', async () => {
    const requestImpl = vi.fn()
      .mockResolvedValueOnce(wireJSON(503, {}))
      .mockResolvedValueOnce(wireJSON(200, { ok: 1 }))
    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      baseDelayMs: 1,
      requestImpl,
    })
    expect(result).toEqual({ ok: true, data: { ok: 1 }, status: 200, attempts: 2 })
    expect(requestImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates byte-cap and unsafe-DNS failures without retrying', async () => {
    for (const [code, error] of [
      ['BODY_TOO_LARGE', 'response-too-large'],
      ['DNS_NON_GLOBAL', 'dns-non-global'],
    ] as const) {
      const requestImpl = vi.fn().mockResolvedValue({
        kind: 'network-error',
        code,
        retryable: false,
        socketAttempts: code === 'BODY_TOO_LARGE' ? 1 : 0,
      } satisfies PinnedHttpResult)
      const result = await fetchJSONWithRetry('https://provider.test/a', {}, { requestImpl })
      expect(result).toMatchObject({ ok: false, status: 0, error })
      expect(requestImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('supports the Ashby POST body without changing its bytes', async () => {
    const payload = JSON.stringify({ includeCompensation: false })
    const requestImpl = vi.fn().mockImplementation(async (request) => {
      expect(request.method).toBe('POST')
      expect(Buffer.from(request.body ?? []).toString('utf8')).toBe(payload)
      expect(new Headers(request.headers).get('content-type')).toBe('application/json')
      return wireJSON(200, { jobs: [] })
    })

    const result = await fetchJSONWithRetry('https://api.ashbyhq.com/posting-api/job-board/acme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }, { requestImpl })

    expect(result).toEqual({ ok: true, data: { jobs: [] }, status: 200, attempts: 1 })
  })

  it('reauthorizes every physical retry and blocks the next socket after revocation', async () => {
    const resolve = vi.fn().mockResolvedValue([publicAnswer])
    const connect = vi.fn().mockResolvedValue({ status: 503, headers: {}, body: Buffer.alloc(0) })
    const beforePhysicalRequest = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const requestImpl = createPinnedHttpClient({ resolve, connect })

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      baseDelayMs: 1,
      beforePhysicalRequest,
      requestImpl,
    })

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: 'source-authority-changed',
      authorityChanged: true,
      attempts: 1,
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(beforePhysicalRequest).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['false', vi.fn().mockResolvedValue(false)],
    ['throw', vi.fn().mockRejectedValue(new Error('revision revoked'))],
  ])('treats an authority %s as lifecycle abort after DNS and before any socket', async (_mode, beforePhysicalRequest) => {
    const connect = vi.fn()
    const requestImpl = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue([publicAnswer]),
      connect,
    })

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      beforePhysicalRequest,
      requestImpl,
    })

    expect(result).toMatchObject({ ok: false, authorityChanged: true, attempts: 0 })
    expect(beforePhysicalRequest).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
  })

  it('propagates a quota rejection without opening a socket', async () => {
    const connect = vi.fn()
    const requestImpl = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue([publicAnswer]),
      connect,
    })
    const beforePhysicalRequest = vi.fn().mockResolvedValue({ allowed: false, reason: 'run-cap' })

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      beforePhysicalRequest,
      requestImpl,
    })

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: 'run-cap',
      requestRejected: 'run-cap',
      attempts: 0,
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('a pre-aborted caller signal short-circuits before DNS or transport', async () => {
    const requestImpl = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const result = await fetchJSONWithRetry(
      'https://provider.test/a',
      { signal: controller.signal },
      { requestImpl },
    )

    expect(result).toEqual({ ok: false, status: 0, error: 'aborted', attempts: 0 })
    expect(requestImpl).not.toHaveBeenCalled()
  })

  it('a mid-flight caller abort kills the pinned request and retry sequence', async () => {
    const controller = new AbortController()
    const requestImpl = vi.fn().mockImplementation((request) => new Promise((resolve) => {
      request.signal.addEventListener('abort', () => resolve({
        kind: 'network-error',
        code: 'ABORT_ERR',
        retryable: false,
        socketAttempts: 1,
      } satisfies PinnedHttpResult), { once: true })
      queueMicrotask(() => controller.abort())
    }))

    const result = await fetchJSONWithRetry(
      'https://provider.test/a',
      { signal: controller.signal },
      { baseDelayMs: 1, requestImpl },
    )

    expect(result).toEqual({ ok: false, status: 0, error: 'aborted', attempts: 1 })
    expect(requestImpl).toHaveBeenCalledTimes(1)
  })

  it('caller abort during retry backoff settles immediately', async () => {
    const controller = new AbortController()
    const requestImpl = vi.fn().mockResolvedValue({
      kind: 'network-error',
      code: 'ECONNRESET',
      retryable: true,
      socketAttempts: 1,
    } satisfies PinnedHttpResult)
    const started = Date.now()
    setTimeout(() => controller.abort(), 10)

    const result = await fetchJSONWithRetry(
      'https://provider.test/a',
      { signal: controller.signal },
      { baseDelayMs: 60_000, requestImpl },
    )

    expect(result).toEqual({ ok: false, status: 0, error: 'aborted', attempts: 1 })
    expect(requestImpl).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('the per-attempt deadline reads as timeout', async () => {
    const requestImpl = vi.fn().mockImplementation((request) => new Promise((resolve) => {
      request.signal.addEventListener('abort', () => resolve({
        kind: 'network-error',
        code: 'ABORT_ERR',
        retryable: false,
        socketAttempts: 1,
      } satisfies PinnedHttpResult), { once: true })
    }))

    const result = await fetchJSONWithRetry('https://provider.test/a', {}, {
      maxRetries: 1,
      timeoutMs: 5,
      requestImpl,
    })

    expect(result).toEqual({ ok: false, status: 0, error: 'timeout', attempts: 1 })
  })
})
