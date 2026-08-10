import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

vi.mock('next-auth/middleware', () => ({
  withAuth: vi.fn((handler: unknown) => handler),
}))

type ControlMiddleware = (request: NextRequest) => NextResponse | Promise<NextResponse>
let controlMiddleware: ControlMiddleware

function request(pathname: string, method = 'GET'): NextRequest {
  const req = new NextRequest(`https://hire.interviewprep.guru${pathname}`, {
    method,
    headers: { host: 'hire.interviewprep.guru' },
  })
  Object.defineProperty(req, 'nextauth', {
    configurable: true,
    value: { token: null },
  })
  return req
}

beforeAll(async () => {
  vi.stubEnv('IPG_SURFACE', 'hire-control')
  vi.resetModules()
  controlMiddleware = (await import('../../../middleware')).default as unknown as ControlMiddleware
})

afterAll(() => vi.unstubAllEnvs())

describe('isolated Hire control route fence', () => {
  it.each([
    ['/history', 'GET'],
    ['/interview', 'GET'],
    ['/api/interviews', 'POST'],
    ['/api/account', 'GET'],
    ['/api/auth/providers', 'GET'],
    ['/api/auth/signin/google', 'POST'],
    ['/api/auth/callback/google', 'GET'],
    ['/api/hire-engine/bootstrap', 'GET'],
    ['/api/internal/hire-engine/revoke', 'POST'],
  ])('default-denies non-control route %s %s', async (path, method) => {
    const response = await controlMiddleware(request(path, method))
    expect(response.status).toBe(404)
  })

  it.each([
    ['/workspace', 'GET'],
    ['/api/workspace', 'GET'],
    ['/candidate/round-id', 'GET'],
    ['/api/candidate/round-id/begin', 'POST'],
    ['/hire-signin', 'GET'],
    ['/api/hire-auth/session', 'GET'],
    ['/api/internal/hire/engine/results', 'POST'],
    ['/api/auth/session', 'GET'],
    ['/api/auth/csrf', 'GET'],
    ['/api/auth/signout', 'POST'],
  ])('keeps required control route %s %s reachable', async (path, method) => {
    const response = await controlMiddleware(request(path, method))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('rewrites only the control root to the workspace', async () => {
    const response = await controlMiddleware(request('/'))
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://hire.interviewprep.guru/workspace',
    )
  })
})
