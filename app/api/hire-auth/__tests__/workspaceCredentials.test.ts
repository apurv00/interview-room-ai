import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  completeSetup: vi.fn(),
  setCookie: vi.fn(),
  revokeLegacy: vi.fn(),
}))

vi.mock('@hire/services/memberAuthService', () => ({
  authenticateHireMember: (...args: unknown[]) => mocks.authenticate(...args),
  completeMemberSetup: (...args: unknown[]) => mocks.completeSetup(...args),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(null),
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
    workspace: { _id: WORKSPACE_ID, name: 'Acme' },
    membership: { _id: 'c'.repeat(24), name: 'HR', email: 'hr@example.com' },
    sessionCredential: SESSION_CREDENTIAL,
    expiresAt: new Date('2026-08-17T00:00:00.000Z'),
  }
  mocks.authenticate.mockResolvedValue(auth)
  mocks.completeSetup.mockResolvedValue(auth)
  mocks.revokeLegacy.mockResolvedValue(undefined)
})

describe('Hire auth workspace credentials', () => {
  it('passes workspaceId with password sign-in and stores the compound session credential', async () => {
    const response = await signIn(request('/api/hire-auth/signin', {
      workspaceId: WORKSPACE_ID,
      email: 'hr@example.com',
      password: 'password',
    }))

    expect(response.status).toBe(200)
    expect(mocks.authenticate).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'hr@example.com',
      'password',
    )
    expect(mocks.setCookie).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_CREDENTIAL,
      expect.any(Date),
    )
    expect(mocks.revokeLegacy).toHaveBeenCalledWith(expect.any(NextRequest))
  })

  it('rejects password sign-in without a workspace coordinate', async () => {
    const response = await signIn(request('/api/hire-auth/signin', {
      email: 'hr@example.com',
      password: 'password',
    }))

    expect(response.status).toBe(400)
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

    const rejected = await setup(request('/api/hire-auth/setup', {
      credential: 'b'.repeat(64),
      password: 'StrongPassword1',
      confirmPassword: 'StrongPassword1',
    }))
    expect(rejected.status).toBe(400)
  })
})
