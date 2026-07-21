import { describe, expect, it, vi } from 'vitest'
import {
  buildPinnedConnectionOptions,
  createPinnedHttpClient,
  readCappedPinnedBody,
  type PinnedConnectImpl,
} from '@shared/pinnedHttpClient'

const publicAnswer = { address: '93.184.216.34', family: 4 as const }
const signal = () => new AbortController().signal
const response = (status = 200, body = '{}') => ({
  status,
  headers: {},
  body: Buffer.from(body),
})

describe('pinned provider HTTP boundary', () => {
  it('resolves once and pins the connector even if the next DNS answer would be private', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce([publicAnswer])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const connect = vi.fn().mockImplementation(async (_request, address) => {
      expect(address).toEqual(publicAnswer)
      return response()
    }) as PinnedConnectImpl
    const request = createPinnedHttpClient({ resolve, connect })

    await expect(request({
      url: 'https://provider.example/jobs',
      signal: signal(),
      maxResponseBytes: 1024,
    })).resolves.toMatchObject({ kind: 'response', socketAttempts: 1 })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it.each([
    [[{ address: '10.0.0.1', family: 4 }]],
    [[publicAnswer, { address: '169.254.169.254', family: 4 }]],
    [[{ address: 'ff02::1', family: 6 }]],
    [[{ address: '93.184.216.34', family: 6 }]],
    [[]],
  ])('rejects private, mixed, malformed or empty DNS before quota and connect', async (answers) => {
    const beforePhysicalRequest = vi.fn().mockResolvedValue(true)
    const connect = vi.fn()
    const request = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue(answers),
      connect,
    })

    const result = await request({
      url: 'https://provider.example/jobs',
      signal: signal(),
      maxResponseBytes: 1024,
      beforePhysicalRequest,
    })

    expect(result).toMatchObject({ kind: 'network-error', socketAttempts: 0 })
    expect(beforePhysicalRequest).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('keeps redirects terminal so credential headers cannot reach Location', async () => {
    const beforePhysicalRequest = vi.fn().mockResolvedValue(true)
    const connect = vi.fn().mockImplementation(async (request) => {
      expect(request.url.toString()).toBe('https://api.provider.example/jobs')
      expect(new Headers(request.headers).get('x-api-key')).toBe('test-key')
      return {
        ...response(302, ''),
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }
    }) as PinnedConnectImpl
    const request = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue([publicAnswer]),
      connect,
    })

    const result = await request({
      url: 'https://api.provider.example/jobs',
      headers: { 'x-api-key': 'test-key' },
      signal: signal(),
      maxResponseBytes: 1024,
      beforePhysicalRequest,
    })

    expect(result).toMatchObject({ kind: 'response', status: 302, socketAttempts: 1 })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(beforePhysicalRequest).toHaveBeenCalledTimes(1)
  })

  it('supports an Ashby-style JSON POST while pinning Host/SNI and body length', async () => {
    const payload = JSON.stringify({ includeCompensation: false })
    const connect = vi.fn().mockImplementation(async (request, address) => {
      expect(request.method).toBe('POST')
      expect(Buffer.from(request.body ?? []).toString('utf8')).toBe(payload)
      const options = buildPinnedConnectionOptions(request, address)
      expect(options).toMatchObject({
        hostname: 'api.ashbyhq.com',
        servername: 'api.ashbyhq.com',
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
      })
      expect(options.headers).toMatchObject({
        Host: 'api.ashbyhq.com',
        'Accept-Encoding': 'identity',
        'Content-Length': String(Buffer.byteLength(payload)),
      })
      expect(new Headers(options.headers as HeadersInit).get('content-type')).toBe('application/json')
      return response(200, '{"jobs":[]}')
    }) as PinnedConnectImpl
    const request = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue([publicAnswer]),
      connect,
    })

    await expect(request({
      url: 'https://api.ashbyhq.com/posting-api/job-board/acme',
      method: 'POST',
      headers: {
        Host: 'attacker.example',
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: signal(),
      maxResponseBytes: 1024,
    })).resolves.toMatchObject({ kind: 'response', status: 200, socketAttempts: 1 })
  })

  it('claims once for each actual fallback socket and never re-resolves', async () => {
    const second = { address: '8.8.8.8', family: 4 as const }
    const resolve = vi.fn().mockResolvedValue([publicAnswer, second])
    const connect = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(response()) as PinnedConnectImpl
    const beforePhysicalRequest = vi.fn().mockResolvedValue(true)
    const request = createPinnedHttpClient({ resolve, connect })

    const result = await request({
      url: 'https://cdn.provider.example/jobs',
      signal: signal(),
      maxResponseBytes: 1024,
      beforePhysicalRequest,
    })

    expect(result).toMatchObject({ kind: 'response', socketAttempts: 2 })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(beforePhysicalRequest).toHaveBeenCalledTimes(2)
  })

  it('propagates caller abort during a pinned socket without another attempt', async () => {
    const controller = new AbortController()
    const connect = vi.fn().mockImplementation((request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
      }, { once: true })
      queueMicrotask(() => controller.abort())
    })) as PinnedConnectImpl
    const beforePhysicalRequest = vi.fn().mockResolvedValue(true)
    const request = createPinnedHttpClient({
      resolve: vi.fn().mockResolvedValue([publicAnswer]),
      connect,
    })

    const result = await request({
      url: 'https://provider.example/jobs',
      signal: controller.signal,
      maxResponseBytes: 1024,
      beforePhysicalRequest,
    })

    expect(result).toEqual({
      kind: 'network-error',
      code: 'ABORT_ERR',
      retryable: false,
      socketAttempts: 1,
    })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(beforePhysicalRequest).toHaveBeenCalledTimes(1)
  })
})

describe('pinned provider response cap', () => {
  it('rejects the stream as soon as it exceeds the byte cap', async () => {
    async function* chunks() {
      yield Buffer.alloc(6, 0x78)
      yield Buffer.alloc(5, 0x79)
      throw new Error('reader continued after cap')
    }
    const onCap = vi.fn()

    await expect(readCappedPinnedBody(chunks(), 10, onCap))
      .rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
    expect(onCap).toHaveBeenCalledTimes(1)
  })
})
