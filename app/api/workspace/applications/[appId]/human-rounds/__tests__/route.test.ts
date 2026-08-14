import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  createGuestHumanRound: vi.fn(),
  createMemberHumanRound: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: await req.json(),
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  createGuestHumanRound: mocks.createGuestHumanRound,
  createMemberHumanRound: mocks.createMemberHumanRound,
  CreateHumanRoundSchema: {},
}))

import { POST } from '../route'

const APPLICATION = '111111111111111111111111'
const round = {
  _id: { toString: () => '222222222222222222222222' },
  mode: 'guest_kit',
  status: 'pending_scorecard',
  openedAt: undefined,
  scorecardSubmittedAt: undefined,
  revokedAt: undefined,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
}

describe('human-round creation API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
    mocks.createGuestHumanRound.mockResolvedValue({
      humanRound: round,
      kit: { _id: 'kit-1' },
      deliveryQueued: true,
    })
    mocks.createMemberHumanRound.mockResolvedValue({ ...round, mode: 'member_room' })
  })

  it('sends guest-kit creation to the Hire service but never exposes the possession URL', async () => {
    const response = await POST(
      new Request(`https://hire.example/api/workspace/applications/${APPLICATION}/human-rounds`, {
        method: 'POST',
        body: JSON.stringify({
          mode: 'guest_kit',
          interviewerName: 'Hiring Manager',
          interviewerEmail: 'manager@example.com',
          operationId: '11111111-1111-4111-8111-111111111111',
        }),
      }) as never,
      { params: { appId: APPLICATION } },
    )
    const body = await response.json()

    expect(mocks.createGuestHumanRound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ applicationId: APPLICATION, interviewerEmail: 'manager@example.com' }),
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toMatchObject({ deliveryQueued: true, humanRound: { id: round._id.toString() } })
    expect(JSON.stringify(body)).not.toContain('raw-possession-capability')
    expect(JSON.stringify(body)).not.toContain('kitUrl')
  })

  it('creates a member-run round without a guest address or public capability', async () => {
    const response = await POST(
      new Request(`https://hire.example/api/workspace/applications/${APPLICATION}/human-rounds`, {
        method: 'POST',
        body: JSON.stringify({
          mode: 'member_room',
          operationId: '22222222-2222-4222-8222-222222222222',
        }),
      }) as never,
      { params: { appId: APPLICATION } },
    )

    expect(await response.json()).toMatchObject({ humanRound: { mode: 'member_room' } })
    expect(mocks.createMemberHumanRound).toHaveBeenCalledWith(
      expect.anything(),
      { applicationId: APPLICATION, operationId: '22222222-2222-4222-8222-222222222222' },
    )
    expect(mocks.createGuestHumanRound).not.toHaveBeenCalled()
  })
})
