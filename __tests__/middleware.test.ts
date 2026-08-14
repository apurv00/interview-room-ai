import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const responseMocks = vi.hoisted(() => ({
  next: vi.fn(() => ({ kind: 'next', headers: new Headers() })),
  redirect: vi.fn((url: URL) => ({ kind: 'redirect', url: url.toString() })),
  rewrite: vi.fn((url: URL) => ({ kind: 'rewrite', url: url.toString() })),
}))

vi.mock('next-auth/middleware', () => ({
  withAuth: vi.fn((handler: unknown) => handler),
}))

vi.mock('next/server', () => ({
  NextResponse: responseMocks,
}))

import middleware from '../middleware'

type Role = 'candidate' | 'platform_admin' | null

function request(url: string, role: Role) {
  const parsed = new URL(url)
  return {
    headers: new Headers({
      host: parsed.host,
      'x-request-id': 'request-id',
    }),
    nextauth: {
      token: role ? { role } : null,
    },
    nextUrl: {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
      clone: () => new URL(parsed),
    },
    url: parsed.toString(),
  }
}

describe('CMS middleware authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('APP_URL', 'https://staging.interviewprep.guru')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['an anonymous visitor', null],
    ['a signed-in non-admin', 'candidate'],
  ] as const)('redirects %s off the CMS subdomain before rewriting', (_label, role) => {
    const response = (middleware as unknown as (req: ReturnType<typeof request>) => unknown)(
      request('https://cms.staging.interviewprep.guru/?from=cms', role),
    )

    expect(response).toEqual({
      kind: 'redirect',
      url: 'https://staging.interviewprep.guru/',
    })
    expect(responseMocks.rewrite).not.toHaveBeenCalled()
  })

  it('rewrites a platform admin from the CMS subdomain into the CMS route tree', () => {
    const response = (middleware as unknown as (req: ReturnType<typeof request>) => unknown)(
      request('https://cms.staging.interviewprep.guru/jobs-ingest', 'platform_admin'),
    )

    expect(response).toEqual({
      kind: 'rewrite',
      url: 'https://cms.staging.interviewprep.guru/cms/jobs-ingest',
    })
  })

  it('redirects a non-admin direct CMS path without looping on the CMS host', () => {
    const response = (middleware as unknown as (req: ReturnType<typeof request>) => unknown)(
      request('https://cms.staging.interviewprep.guru/cms/jobs-ingest', 'candidate'),
    )

    expect(response).toEqual({
      kind: 'redirect',
      url: 'https://staging.interviewprep.guru/',
    })
  })

  it('keeps excluded sign-in paths reachable on the CMS subdomain', () => {
    const response = (middleware as unknown as (req: ReturnType<typeof request>) => unknown)(
      request('https://cms.staging.interviewprep.guru/signin', null),
    )

    expect(response).toMatchObject({ kind: 'next' })
    expect(responseMocks.redirect).not.toHaveBeenCalled()
    expect(responseMocks.rewrite).not.toHaveBeenCalled()
  })

  it('fails safely to same-host sign-in when the primary app URL is not configured', () => {
    vi.stubEnv('APP_URL', '')
    vi.stubEnv('NEXTAUTH_URL', '')

    const response = (middleware as unknown as (req: ReturnType<typeof request>) => unknown)(
      request('https://cms.example.test/', 'candidate'),
    )

    expect(response).toEqual({
      kind: 'redirect',
      url: 'https://cms.example.test/signin',
    })
  })
})

describe('Hire public interview-kit routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the no-login kit page outside the hire workspace rewrite and sets no-referrer', () => {
    const response = (middleware as unknown as (req: ReturnType<typeof request>) => {
      kind: string
      headers: Headers
    })(
      request(`https://hire.staging.interviewprep.guru/interview-kit/${'a'.repeat(24)}`, null),
    )

    expect(response.kind).toBe('next')
    expect(responseMocks.rewrite).not.toHaveBeenCalled()
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })
})
