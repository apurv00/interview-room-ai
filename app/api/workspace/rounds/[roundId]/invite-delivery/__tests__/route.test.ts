import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  roundFindOne: vi.fn(),
  getViews: vi.fn(),
  deliver: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: {},
    params: context?.params ?? {},
  }),
}))
vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  HireRound: { findOne: mocks.roundFindOne },
  getAiInviteDeliveryViews: mocks.getViews,
  deliverAiInvite: mocks.deliver,
}))

import { GET, POST } from '../route'

const WORKSPACE = '111111111111111111111111'
const ROUND = '222222222222222222222222'
const URL = `https://hire.interviewprep.guru/candidate/${ROUND}#invite=${WORKSPACE}.secret`
const ctx = {
  workspace: { _id: WORKSPACE },
  membership: { _id: '333333333333333333333333' },
}
const round = { _id: ROUND }
const view = {
  roundId: ROUND,
  status: 'failed',
  attempts: 1,
  expiresAt: new Date('2026-08-17T00:00:00.000Z'),
  sentAt: null,
  lastError: 'Provider did not accept the invitation',
  inviteUrl: URL,
  recoverable: true,
}

describe('AI invite delivery API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.roundFindOne.mockResolvedValue(round)
    mocks.getViews.mockResolvedValue(new Map([[ROUND, view]]))
    mocks.deliver.mockResolvedValue({ view: { ...view, status: 'sent' }, emailSent: true })
  })

  it('returns the copyable fragment only through the authenticated no-store route', async () => {
    const response = await GET(
      new Request(`https://hire.interviewprep.guru/api/workspace/rounds/${ROUND}/invite-delivery`) as never,
      { params: { roundId: ROUND } },
    )
    const body = await response.json()

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.delivery.inviteUrl).toBe(URL)
    expect(mocks.roundFindOne).toHaveBeenCalledWith({
      _id: ROUND,
      workspaceId: WORKSPACE,
    })
  })

  it('marks member retries and returns the idempotent delivery result', async () => {
    const response = await POST(
      new Request(`https://hire.interviewprep.guru/api/workspace/rounds/${ROUND}/invite-delivery`, {
        method: 'POST',
      }) as never,
      { params: { roundId: ROUND } },
    )
    expect(await response.json()).toMatchObject({ emailSent: true })
    expect(mocks.deliver).toHaveBeenCalledWith(ctx, ROUND, { manualRetry: true })
  })
})
