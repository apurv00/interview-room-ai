import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) => async (req: Request, context?: { params?: Record<string, string> }) =>
      options.handler(req, {
        user: { id: 'member-user', email: 'hr@example.com' },
        body: {},
        params: context?.params ?? {},
      }),
}))
vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
}))
vi.mock('@/modules/hire-status/services/candidateStatusLinkService', () => ({
  revokeCandidateStatusLink: mocks.revoke,
}))

import { POST } from '../route'

const LINK_ID = '2'.repeat(24)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue({
    workspace: { _id: { toString: () => 'workspace-1' } },
    membership: { _id: { toString: () => 'membership-1' }, name: 'Hiring manager' },
  })
  mocks.revoke.mockResolvedValue({
    id: LINK_ID,
    applicationId: '1'.repeat(24),
    active: false,
    expiresAt: new Date('2026-09-13T10:00:00.000Z'),
    revokedAt: new Date('2026-08-14T10:00:00.000Z'),
  })
})

describe('candidate status-link member revocation route', () => {
  it('revokes only through member authority and returns bounded lifecycle state', async () => {
    const response = await POST(
      new Request(`https://hire.example/api/workspace/candidate-status-links/${LINK_ID}/revoke`, {
        method: 'POST',
      }) as never,
      { params: { linkId: LINK_ID } },
    )

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.revoke).toHaveBeenCalledWith({
      authority: {
        workspaceId: 'workspace-1',
        memberId: 'membership-1',
        memberName: 'Hiring manager',
      },
      linkId: LINK_ID,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      candidateStatusLink: {
        id: LINK_ID,
        active: false,
        revokedAt: '2026-08-14T10:00:00.000Z',
      },
    })
  })
})
