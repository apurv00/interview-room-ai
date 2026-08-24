import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  resolveHireMemberSession: vi.fn(),
  resolveHireMemberRequestSession: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  incr: vi.fn(),
  pexpire: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))

vi.mock('@shared/redis', () => ({
  redis: {
    incr: mocks.incr,
    pexpire: mocks.pexpire,
  },
}))

vi.mock('@shared/services/stripe', () => ({
  getPlanLimits: () => ({ rateLimitPerMin: 15 }),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { error: vi.fn() },
}))

vi.mock('@hire/services/memberAuthService', () => ({
  resolveHireMemberSession: mocks.resolveHireMemberSession,
}))

vi.mock('../../../hire-auth/_lib/memberSession', () => ({
  resolveHireMemberRequestSession: mocks.resolveHireMemberRequestSession,
  applyHireMemberRequestCookies: (response: NextResponse) => response,
}))

vi.mock('@hire/services/workspaceService', () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
}))

import { composeHireApiRoute } from '../composeHireApiRoute'

const USER = {
  id: '69b04a6c8ba3596e447148e9',
  email: 'workspace-admin@example.com',
  role: 'candidate',
  plan: 'free',
}

function workspaceContext(id: string) {
  return {
    workspace: { _id: { toString: () => id } },
    membership: { _id: 'member-id' },
  }
}

function request(path: string, method = 'GET', origin?: string) {
  return new NextRequest(`https://hire.interviewprep.guru${path}`, {
    method,
    ...(origin ? { headers: { origin } } : {}),
  })
}

function route(handler = vi.fn(async () => NextResponse.json({ ok: true }))) {
  return composeHireApiRoute({
    rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'test' },
    handler,
  })
}

describe('composeHireApiRoute B2C workspace bootstrap fence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = 'test'
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_PUBLIC_URL = 'https://hire.interviewprep.guru'
    mocks.getServerSession.mockResolvedValue({ user: USER })
    mocks.resolveHireMemberSession.mockResolvedValue(null)
    mocks.resolveHireMemberRequestSession.mockResolvedValue({
      auth: null,
      clearLegacyCookie: false,
      clearCurrentCookie: false,
    })
    mocks.incr.mockResolvedValue(1)
    mocks.pexpire.mockResolvedValue(1)
  })

  it('allows a valid unlinked HR principal to discover that no workspace exists', async () => {
    mocks.getWorkspaceForUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const response = await route()(request('/api/workspace'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledTimes(2)
  })

  it('allows the first workspace created during the request to cross the egress fence', async () => {
    mocks.getWorkspaceForUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(workspaceContext('workspace-new'))
    const handler = vi.fn(async () => NextResponse.json({ created: true }, { status: 201 }))

    const response = await route(handler)(request('/api/workspace', 'POST'))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ created: true })
  })

  it('does not release private output when an existing membership disappears', async () => {
    mocks.getWorkspaceForUser
      .mockResolvedValueOnce(workspaceContext('workspace-a'))
      .mockResolvedValueOnce(null)

    const response = await route()(request('/api/workspace'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('keeps every non-onboarding route membership gated', async () => {
    mocks.getWorkspaceForUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const response = await route()(request('/api/workspace/jobs'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })
})

describe('composeHireApiRoute trusted Origin fence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = 'production'
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_PUBLIC_URL = 'https://hire.interviewprep.guru'
    mocks.getServerSession.mockResolvedValue({ user: USER })
    mocks.resolveHireMemberRequestSession.mockResolvedValue({
      auth: null,
      clearLegacyCookie: false,
      clearCurrentCookie: false,
    })
    mocks.getWorkspaceForUser.mockResolvedValue(
      workspaceContext('workspace-a'),
    )
    mocks.incr.mockResolvedValue(1)
    mocks.pexpire.mockResolvedValue(1)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects missing Origin on %s before authentication or mutation',
    async (method) => {
      const handler = vi.fn(async () => NextResponse.json({ mutated: true }))

      const response = await route(handler)(
        request('/api/workspace/members', method),
      )

      expect(response.status).toBe(403)
      expect(mocks.resolveHireMemberRequestSession).not.toHaveBeenCalled()
      expect(mocks.getServerSession).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('rejects a sibling-origin representative workspace mutation', async () => {
    const handler = vi.fn(async () => NextResponse.json({ mutated: true }))

    const response = await route(handler)(
      request(
        '/api/workspace/members',
        'POST',
        'https://evil.interviewprep.guru',
      ),
    )

    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('allows the exact Hire Origin to reach a representative mutation', async () => {
    const handler = vi.fn(async () => NextResponse.json({ mutated: true }))

    const response = await route(handler)(
      request(
        '/api/workspace/members',
        'POST',
        'https://hire.interviewprep.guru',
      ),
    )

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects a legacy-only member cookie so login CSRF cannot reach a mutation', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    mocks.resolveHireMemberRequestSession.mockResolvedValue({
      auth: null,
      clearLegacyCookie: true,
      clearCurrentCookie: false,
    })
    const handler = vi.fn(async () => NextResponse.json({ mutated: true }))
    const legacyRequest = new NextRequest(
      'https://hire.interviewprep.guru/api/workspace/members',
      {
        method: 'POST',
        headers: {
          origin: 'https://hire.interviewprep.guru',
          cookie: `__Secure-ipg-hire-member=${'2'.repeat(24)}.${'b'.repeat(64)}`,
        },
      },
    )

    const response = await route(handler)(legacyRequest)

    expect(response.status).toBe(401)
    expect(mocks.resolveHireMemberRequestSession).toHaveBeenCalledWith(
      legacyRequest,
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('allows a safe workspace read without Origin', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))

    const response = await route(handler)(
      request('/api/workspace/members', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })
})
