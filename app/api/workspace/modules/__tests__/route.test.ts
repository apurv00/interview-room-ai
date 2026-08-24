import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readCommercial: vi.fn(),
}))

vi.mock('../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) =>
    (request: Request) =>
      options.handler(request, {
        user: { id: 'member-1', email: 'admin@example.com' },
        body: {},
        params: {},
      }),
}))
vi.mock('@hire-operations-boundary', () => ({
  requireMembership: mocks.requireMembership,
}))
vi.mock('@hire-commercial', () => ({
  readHireCommercialWorkspace: mocks.readCommercial,
}))

import { GET } from '../route'

const ctx = {
  workspace: { _id: '111111111111111111111111' },
  membership: { role: 'admin' },
}
const view = {
  catalogVersion: 'hire-commercial-v1',
  enforcement: 'shadow',
  source: 'compatibility_default',
  pilotStatus: 'not_requested',
  usage: {
    screenAssessmentsCompleted: 0,
    measurementStartedAt: null,
    scope: 'shadow_era',
  },
  modules: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireMembership.mockResolvedValue(ctx)
  mocks.readCommercial.mockResolvedValue(view)
})

describe('GET /api/workspace/modules', () => {
  it('derives scope from membership and returns a private no-store projection', async () => {
    const response = await GET(
      new Request(
        'https://hire.example/api/workspace/modules?workspaceId=foreign',
      ) as never,
    )

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-1',
      email: 'admin@example.com',
    })
    expect(mocks.readCommercial).toHaveBeenCalledWith(ctx)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual(view)
  })

  it('stops before commercial reads when membership is unavailable', async () => {
    mocks.requireMembership.mockRejectedValue(new Error('membership required'))

    await expect(
      GET(new Request('https://hire.example/api/workspace/modules') as never),
    ).rejects.toThrow('membership required')
    expect(mocks.readCommercial).not.toHaveBeenCalled()
  })
})
