import { afterEach, describe, expect, it, vi } from 'vitest'

const responseMocks = vi.hoisted(() => {
  const next = vi.fn(() => ({ kind: 'next', headers: new Headers() }))
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(
      _body?: unknown,
      init?: { status?: number; headers?: HeadersInit },
    ) {
      this.status = init?.status ?? 200
      this.headers = new Headers(init?.headers)
    }
  }
  return {
    next,
    NextResponse: Object.assign(MockNextResponse, {
      next,
      redirect: vi.fn(),
      rewrite: vi.fn(),
      json: vi.fn(),
    }),
  }
})

vi.mock('next-auth/middleware', () => ({
  withAuth: vi.fn((handler: unknown) => handler),
}))
vi.mock('next/server', () => ({ NextResponse: responseMocks.NextResponse }))

function request(pathname = '/') {
  const url = new URL(pathname, 'https://example.test')
  return {
    headers: new Headers({ host: url.host }),
    method: 'GET',
    nextauth: { token: null },
    nextUrl: {
      pathname: url.pathname,
      searchParams: url.searchParams,
      clone: () => new URL(url),
    },
    url: url.toString(),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('deployment surface middleware fence', () => {
  it.each([undefined, 'hire-contorl', ' hire-engine ', '   '])(
    'returns 503 before route handling for invalid Hire surface %s',
    async (surface) => {
      if (surface === undefined) vi.stubEnv('IPG_SURFACE', '')
      else vi.stubEnv('IPG_SURFACE', surface)
      vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', 'ipg-hire-control')

      const { default: middleware } = await import('../middleware')
      const response = (middleware as unknown as (req: unknown) => {
        status: number
        headers: Headers
      })(request('/api/inngest'))

      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(responseMocks.next).not.toHaveBeenCalled()
    },
  )

  it('preserves the blank legacy B2C surface when no Hire manifest exists', async () => {
    vi.stubEnv('IPG_SURFACE', '')
    vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', '')
    vi.stubEnv('HIRE_RUNTIME_DATABASE_NAME', '')

    const { default: middleware } = await import('../middleware')
    const response = (middleware as unknown as (req: unknown) => unknown)(request())

    expect(response).toMatchObject({ kind: 'next' })
  })

  it('fails closed for an incomplete Hire-only manifest without DB markers', async () => {
    vi.stubEnv('IPG_SURFACE', '')
    vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', '')
    vi.stubEnv('HIRE_RUNTIME_DATABASE_NAME', '')
    vi.stubEnv('HIRE_ENGINE_RUNTIME_URL', 'https://engine.example.test')

    const { default: middleware } = await import('../middleware')
    const response = (middleware as unknown as (req: unknown) => {
      status: number
    })(request())

    expect(response.status).toBe(503)
    expect(responseMocks.next).not.toHaveBeenCalled()
  })

  it('preserves explicit B2C behavior even when the manifest retains Hire markers', async () => {
    vi.stubEnv('IPG_SURFACE', 'b2c')
    vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', 'ipg-hire-control')
    vi.stubEnv('HIRE_ENGINE_RUNTIME_URL', 'https://engine.example.test')

    const { default: middleware } = await import('../middleware')
    const response = (middleware as unknown as (req: unknown) => unknown)(request())

    expect(response).toMatchObject({ kind: 'next' })
  })
})
