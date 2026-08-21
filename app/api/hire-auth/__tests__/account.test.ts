import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { AppError } from '@shared/errors'

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  hasTrustedOrigin: vi.fn(),
  resolveHireMemberRequestSession: vi.fn(),
  selfDeleteHireMember: vi.fn(),
  clearHireMemberCookie: vi.fn(),
}))

vi.mock('@shared/middleware/checkRateLimit', () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
}))
vi.mock('../_lib/request', () => ({
  clientIp: () => '203.0.113.5',
  hasTrustedOrigin: (...args: unknown[]) => mocks.hasTrustedOrigin(...args),
}))
vi.mock('../_lib/cookie', () => ({
  clearHireMemberCookie: (...args: unknown[]) => mocks.clearHireMemberCookie(...args),
}))
vi.mock('../_lib/memberSession', () => ({
  resolveHireMemberRequestSession: (...args: unknown[]) =>
    mocks.resolveHireMemberRequestSession(...args),
  applyHireMemberRequestCookies: (response: unknown) => response,
}))
vi.mock('@hire/services/memberLifecycleService', () => ({
  selfDeleteHireMember: (...args: unknown[]) => mocks.selfDeleteHireMember(...args),
}))

import { DELETE } from '../account/route'

const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000'

function request(body: Record<string, unknown> = { operationId: OPERATION_ID }) {
  return new NextRequest('https://hire.interviewprep.guru/api/hire-auth/account', {
    method: 'DELETE',
    headers: {
      origin: 'https://hire.interviewprep.guru',
      cookie: 'ipg-hire-member=raw-session',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasTrustedOrigin.mockReturnValue(true)
  mocks.checkRateLimit.mockResolvedValue(null)
  mocks.resolveHireMemberRequestSession.mockResolvedValue({
    auth: {
      workspace: { _id: '111111111111111111111111', name: 'Acme Hiring' },
      membership: { _id: '222222222222222222222222', role: 'member' },
    },
    sessionCredential: 'raw-session',
    clearLegacyCookie: false,
  })
})

describe('DELETE /api/hire-auth/account', () => {
  it('deletes only the authenticated direct Hire member and clears its cookie', async () => {
    mocks.selfDeleteHireMember.mockResolvedValue({ workspaceDeletionScheduled: false })

    const response = await DELETE(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspaceDeletionScheduled: false,
    })
    expect(mocks.resolveHireMemberRequestSession).toHaveBeenCalledWith(
      expect.any(NextRequest),
    )
    expect(mocks.selfDeleteHireMember).toHaveBeenCalledWith(
      expect.objectContaining({ membership: expect.objectContaining({ role: 'member' }) }),
      { operationId: OPERATION_ID },
    )
    expect(mocks.clearHireMemberCookie).toHaveBeenCalledWith(response)
  })

  it('does not accept a B2C session when the Hire member cookie is absent', async () => {
    mocks.resolveHireMemberRequestSession.mockResolvedValue({
      auth: null,
      clearLegacyCookie: false,
    })
    const noCookie = new NextRequest(
      'https://hire.interviewprep.guru/api/hire-auth/account',
      {
        method: 'DELETE',
        headers: {
          origin: 'https://hire.interviewprep.guru',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: OPERATION_ID }),
      },
    )

    const response = await DELETE(noCookie)

    expect(response.status).toBe(401)
    expect(mocks.resolveHireMemberRequestSession).toHaveBeenCalledWith(
      expect.any(NextRequest),
    )
    expect(mocks.selfDeleteHireMember).not.toHaveBeenCalled()
  })

  it('surfaces the admin transfer gate without clearing the live session', async () => {
    mocks.selfDeleteHireMember.mockRejectedValue(
      new AppError('Transfer administrator access first', 409, 'HIRE_ADMIN_TRANSFER_REQUIRED'),
    )

    const response = await DELETE(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Transfer administrator access first',
      code: 'HIRE_ADMIN_TRANSFER_REQUIRED',
    })
    expect(mocks.clearHireMemberCookie).not.toHaveBeenCalled()
  })

  it('rejects an untrusted cross-origin deletion before reading the session', async () => {
    mocks.hasTrustedOrigin.mockReturnValue(false)

    const response = await DELETE(request())

    expect(response.status).toBe(403)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.resolveHireMemberRequestSession).not.toHaveBeenCalled()
  })
})
