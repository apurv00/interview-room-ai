import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  addMember: vi.fn(),
}))

vi.mock('../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => (req: Request) => options.handler(req, {
    user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
    body: { name: 'New Person', email: 'new@acme.com' },
    params: {},
  }),
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  addMember: mocks.addMember,
  listMembers: vi.fn(),
  AddMemberSchema: {},
}))

vi.mock('../../_lib/serialize', () => ({
  serializeMember: (member: { _id: string }) => ({ id: member._id }),
}))

import { POST } from '../route'

describe('POST /api/workspace/members', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: '111111111111111111111111' },
      membership: { _id: '222222222222222222222222', role: 'admin' },
    })
    mocks.addMember.mockResolvedValue({
      member: { _id: '333333333333333333333333' },
      setupUrl: 'https://hire.interviewprep.guru/hire-signin#setup=workspace.secret',
      expiresAt: new Date('2026-08-11T00:00:00.000Z'),
      emailSent: true,
    })
  })

  it('returns the one-time setup credential in a no-store response', async () => {
    const response = await POST(
      new Request('https://hire.interviewprep.guru/api/workspace/members', {
        method: 'POST',
      }) as never,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      member: { id: '333333333333333333333333' },
      credentialSetup: {
        emailSent: true,
      },
    })
  })
})
