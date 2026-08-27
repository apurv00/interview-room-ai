import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  completeSetup: vi.fn(),
  rateLimit: vi.fn(),
  setCookie: vi.fn(),
  revokeLegacy: vi.fn(),
}))

vi.mock('@hire/services/memberAuthService', () => ({
  authenticateHireMember: (...args: unknown[]) => mocks.authenticate(...args),
  completeMemberSetup: (...args: unknown[]) => mocks.completeSetup(...args),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: (...args: unknown[]) => mocks.rateLimit(...args),
}))

vi.mock('../_lib/cookie', () => ({
  setHireMemberCookie: (...args: unknown[]) => mocks.setCookie(...args),
}))

vi.mock('../_lib/memberSession', () => ({
  revokeLegacyRequestHireMemberSession: (...args: unknown[]) =>
    mocks.revokeLegacy(...args),
}))

vi.mock('../_lib/request', () => ({
  clientIp: () => '127.0.0.1',
  hasTrustedOrigin: () => true,
}))

import { POST as signIn } from '../signin/route'
import { POST as setup } from '../setup/route'

const WORKSPACE_ID = 'a'.repeat(24)
const SESSION_CREDENTIAL = `${WORKSPACE_ID}.${'b'.repeat(64)}`

function request(path: string, body: unknown) {
  return new NextRequest(`https://hire.interviewprep.guru${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  const auth = {
    workspace: { _id: WORKSPACE_ID, name: 'Acme', signInSlug: 'acme' },
    membership: { _id: 'c'.repeat(24), name: 'HR', email: 'hr@example.com' },
    sessionCredential: SESSION_CREDENTIAL,
    expiresAt: new Date('2026-08-17T00:00:00.000Z'),
  }
  mocks.authenticate.mockResolvedValue(auth)
  mocks.completeSetup.mockResolvedValue(auth)
  mocks.revokeLegacy.mockResolvedValue(undefined)
  mocks.rateLimit.mockResolvedValue(null)
})

describe('Hire auth workspace credentials', () => {
  it('passes the company workspace slug and returns it without exposing the internal id', async () => {
    const response = await signIn(request('/api/hire-auth/signin', {
      workspace: 'acme',
      email: 'hr@example.com',
      password: 'password',
    }))

    expect(response.status).toBe(200)
    expect(mocks.authenticate).toHaveBeenCalledWith(
      'acme',
      'hr@example.com',
      'password',
    )
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(
      1,
      '127.0.0.1',
      expect.objectContaining({
        keyPrefix: 'rl:hire-member-signin-ip',
        failClosed: true,
      }),
    )
    const [subject, subjectConfig] = mocks.rateLimit.mock.calls[1]
    expect(subject).toMatch(/^[a-f0-9]{64}$/)
    expect(subject).not.toContain('acme')
    expect(subject).not.toContain('hr@example.com')
    expect(subjectConfig).toEqual(expect.objectContaining({
      keyPrefix: 'rl:hire-member-signin-subject',
      failClosed: true,
    }))
    expect(mocks.setCookie).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_CREDENTIAL,
      expect.any(Date),
    )
    expect(mocks.revokeLegacy).toHaveBeenCalledWith(expect.any(NextRequest))
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspace: { slug: 'acme', name: 'Acme' },
    })
  })

  it('continues to accept one legacy ObjectId coordinate but rejects ambiguous inputs', async () => {
    const legacy = await signIn(request('/api/hire-auth/signin', {
      workspaceId: WORKSPACE_ID,
      email: 'hr@example.com',
      password: 'password',
    }))
    expect(legacy.status).toBe(200)
    expect(mocks.authenticate).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'hr@example.com',
      'password',
    )

    mocks.authenticate.mockClear()
    const ambiguous = await signIn(request('/api/hire-auth/signin', {
      workspace: 'acme',
      workspaceId: WORKSPACE_ID,
      email: 'hr@example.com',
      password: 'password',
    }))
    expect(ambiguous.status).toBe(400)
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  it('rejects password sign-in without a workspace coordinate', async () => {
    const response = await signIn(request('/api/hire-auth/signin', {
      email: 'hr@example.com',
      password: 'password',
    }))

    expect(response.status).toBe(400)
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  it('stops a distributed credential subject before authentication', async () => {
    mocks.rateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Response(null, { status: 429 }))

    const response = await signIn(request('/api/hire-auth/signin', {
      workspace: 'acme',
      email: 'hr@example.com',
      password: 'password',
    }))

    expect(response.status).toBe(429)
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  it('accepts only a workspace-bearing first-password credential', async () => {
    const response = await setup(request('/api/hire-auth/setup', {
      credential: SESSION_CREDENTIAL,
      password: 'StrongPassword1',
      confirmPassword: 'StrongPassword1',
    }))

    expect(response.status).toBe(200)
    expect(mocks.completeSetup).toHaveBeenCalledWith(SESSION_CREDENTIAL, 'StrongPassword1')
    expect(mocks.revokeLegacy).toHaveBeenCalledWith(expect.any(NextRequest))
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: WORKSPACE_ID, slug: 'acme', name: 'Acme' },
    })

    const rejected = await setup(request('/api/hire-auth/setup', {
      credential: 'b'.repeat(64),
      password: 'StrongPassword1',
      confirmPassword: 'StrongPassword1',
    }))
    expect(rejected.status).toBe(400)
  })
})
