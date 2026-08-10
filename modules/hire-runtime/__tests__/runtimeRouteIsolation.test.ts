import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

vi.mock('next-auth/middleware', () => ({
  withAuth: vi.fn((handler: unknown) => handler),
}))

type RuntimeMiddleware = (request: NextRequest) => NextResponse | Promise<NextResponse>

let runtimeMiddleware: RuntimeMiddleware

function request(
  pathname: string,
  method = 'GET',
  includeB2CCookie = false,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers({
    host: 'engine.interviewprep.guru',
    ...extraHeaders,
  })
  if (includeB2CCookie) {
    headers.set(
      'cookie',
      '__Secure-next-auth.session-token=domain-wide-b2c-token',
    )
  }
  const req = new NextRequest(`https://engine.interviewprep.guru${pathname}`, {
    method,
    headers,
  })
  Object.defineProperty(req, 'nextauth', {
    configurable: true,
    value: { token: null },
  })
  return req
}

beforeAll(async () => {
  vi.stubEnv('IPG_SURFACE', 'hire-engine')
  vi.stubEnv('HIRE_RUNTIME_FENCE_SECRET', 'f'.repeat(64))
  vi.resetModules()
  runtimeMiddleware = (await import('../../../middleware'))
    .default as unknown as RuntimeMiddleware
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('isolated runtime route fence', () => {
  it.each([
    ['/history', 'GET'],
    ['/workspace', 'GET'],
    ['/learn/pathway', 'GET'],
    ['/candidate/round-id', 'GET'],
    ['/api/account', 'GET'],
    ['/api/workspace', 'GET'],
    ['/api/candidate/round-id/start', 'POST'],
    ['/api/internal/hire/engine/exchange', 'POST'],
    ['/api/internal/hire/engine/results', 'POST'],
    ['/api/interviews', 'GET'],
    [`/api/interviews/${'a'.repeat(24)}`, 'GET'],
    ['/api/generate-feedback', 'GET'],
    ['/api/analysis/start', 'POST'],
  ])('default-denies non-engine or wrong-method route %s %s', async (path, method) => {
    const response = await runtimeMiddleware(request(path, method))
    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Not found')
  })

  it('does not let a domain-wide B2C cookie escape the runtime allowlist', async () => {
    const response = await runtimeMiddleware(request('/history', 'GET', true))
    expect(response.status).toBe(404)
  })

  it('rewrites only POST session creation into the canonical runtime provisioner', async () => {
    const response = await runtimeMiddleware(request('/api/interviews', 'POST'))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://engine.interviewprep.guru/api/hire-engine/sessions',
    )
  })

  it('redirects every feedback path to the neutral completion page and drops its query', async () => {
    const response = await runtimeMiddleware(
      request(`/feedback/${'a'.repeat(24)}?shareToken=must-not-survive`),
    )
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'https://engine.interviewprep.guru/handoff/complete',
    )
  })

  it.each([
    ['/handoff', 'GET'],
    ['/handoff/complete', 'GET'],
    ['/api/auth/session', 'GET'],
    ['/api/hire-engine/bootstrap', 'GET'],
    ['/api/internal/hire-engine/revoke', 'POST'],
    ['/lobby', 'GET'],
    ['/interview', 'GET'],
    ['/api/settings/usage', 'GET'],
  ])('keeps only the required runtime route %s %s reachable', async (path, method) => {
    const response = await runtimeMiddleware(request(path, method))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([
    ['/api/generate-feedback?source=browser', 'POST', '/api/generate-feedback'],
    ['/api/tts?voice=indian', 'POST', '/api/tts'],
    [`/api/interviews/${'a'.repeat(24)}?final=true`, 'PATCH', `/api/interviews/${'a'.repeat(24)}`],
  ])('rewrites mutable engine route %s through the capability fence', async (path, method, target) => {
    const response = await runtimeMiddleware(request(path, method))
    expect(response.status).toBe(200)
    const rewritten = new URL(response.headers.get('x-middleware-rewrite') || '')
    expect(rewritten.pathname).toBe('/api/hire-engine/write-fence')
    expect(rewritten.searchParams.get('__runtime_target')).toBe(target)
    const [queryKey, queryValue] = path.includes('source=')
      ? ['source', 'browser']
      : path.includes('voice=')
        ? ['voice', 'indian']
        : ['final', 'true']
    expect(rewritten.searchParams.get(queryKey)).toBe(queryValue)
  })

  it.each([
    ['/api/tts', '/api/hire-engine/tts'],
    ['/api/tts/stream?encoding=opus', '/api/hire-engine/tts/stream'],
  ])('routes admitted TTS %s to the runtime-owned no-cache boundary', async (path, target) => {
    const response = await runtimeMiddleware(
      request(path, 'POST', false, {
        'x-ipg-hire-runtime-fence-bypass': 'f'.repeat(64),
      }),
    )
    expect(response.status).toBe(200)
    const rewritten = new URL(response.headers.get('x-middleware-rewrite') || '')
    expect(rewritten.pathname).toBe(target)
    if (path.includes('encoding=')) {
      expect(rewritten.searchParams.get('encoding')).toBe('opus')
    }
  })

  it('allows only the strong internal bypass on an allow-listed write', async () => {
    const response = await runtimeMiddleware(
      request('/api/generate-feedback', 'POST', false, {
        'x-ipg-hire-runtime-fence-bypass': 'f'.repeat(64),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([
    ['/api/generate-feedback', 'wrong-secret'],
    ['/api/settings/usage', 'f'.repeat(64)],
  ])('rejects a forged or out-of-scope bypass for %s', async (path, bypass) => {
    const response = await runtimeMiddleware(
      request(path, 'POST', false, {
        'x-ipg-hire-runtime-fence-bypass': bypass,
      }),
    )
    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Not found')
  })
})
