import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  regenerate: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
    body: {},
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire/services/workspaceService', () => ({
  requireMembership: mocks.requireMembership,
  regenerateMemberSetup: mocks.regenerate,
}))

import { POST } from '../route'

const MEMBER_ID = '222222222222222222222222'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

describe('POST /api/workspace/members/[memberId]/setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.regenerate.mockResolvedValue({
      setupUrl: 'https://hire.interviewprep.guru/hire-signin#setup=workspace.secret',
      expiresAt: new Date('2026-08-11T00:00:00.000Z'),
      emailSent: false,
    })
  })

  it('regenerates through the authenticated workspace membership', async () => {
    const response = await POST(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/members/${MEMBER_ID}/setup`,
        { method: 'POST' },
      ) as never,
      { params: { memberId: MEMBER_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      credentialSetup: {
        url: 'https://hire.interviewprep.guru/hire-signin#setup=workspace.secret',
        expiresAt: '2026-08-11T00:00:00.000Z',
        emailSent: false,
      },
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.regenerate).toHaveBeenCalledWith(ctx, MEMBER_ID)
  })
})
