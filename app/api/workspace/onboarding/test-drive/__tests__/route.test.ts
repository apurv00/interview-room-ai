import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) => async (req: Request) =>
      options.handler(req, {
        user: { id: 'member-user', email: 'hr@example.com' },
        body: options.schema ? await req.json() : {},
        params: {},
      }),
}))
vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
}))
vi.mock('@/modules/hire-onboarding/services/testDriveService', () => ({
  getHireOnboardingTestDrive: mocks.get,
  removeHireOnboardingTestDrive: mocks.remove,
}))

import { DELETE, GET, POST } from '../route'

const view = {
  id: 'test-drive-1',
  label: 'Interview yourself' as const,
  state: 'ready' as const,
  jobId: 'job-1',
  candidateId: 'candidate-1',
  applicationId: 'application-1',
  roundId: 'round-1',
  issuedAt: new Date('2099-08-14T00:00:00.000Z'),
  cleanupAfter: new Date('2099-08-28T00:00:00.000Z'),
  removedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({
    workspace: { _id: { toString: () => 'workspace-1' } },
    membership: { _id: { toString: () => 'member-1' }, name: 'Hiring manager' },
  })
  mocks.get.mockResolvedValue(null)
  mocks.remove.mockResolvedValue({ ...view, state: 'removed', removedAt: new Date() })
})

describe('member onboarding test-drive route', () => {
  it('reads only the current member-owned safe state and marks it no-store', async () => {
    const response = await GET(
      new Request('https://hire.example/api/workspace/onboarding/test-drive?workspaceId=foreign') as never,
    )

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.anything() }))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    await expect(response.json()).resolves.toEqual({ testDrive: null })
  })

  it('rejects new practice creation while preserving member-only response headers', async () => {
    const response = await POST(
      new Request('https://hire.example/api/workspace/onboarding/test-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: '11111111-1111-4111-8111-111111111111' }),
      }) as never,
    )

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    await expect(response.json()).resolves.toEqual({
      error: 'Hire practice interviews have been retired.',
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
  })

  it('uses no client-supplied coordinate to authorize member cleanup', async () => {
    const response = await DELETE(
      new Request('https://hire.example/api/workspace/onboarding/test-drive?testDriveId=foreign', {
        method: 'DELETE',
      }) as never,
    )

    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.anything(), membership: expect.anything() }),
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      testDrive: { id: 'test-drive-1', state: 'removed' },
    })
  })
})
