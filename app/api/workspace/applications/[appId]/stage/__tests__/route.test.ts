import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  moveStage: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: { handler: Function }) =>
    async (request: Request, context?: { params?: Record<string, string> }) =>
      options.handler(request, {
        user: { id: 'member-user', email: 'hr@example.com' },
        body: await request.json(),
        params: context?.params ?? {},
      }),
}))
vi.mock('@hire', () => ({
  HIRE_STAGE_REASON_CODES: [
    'requirements_mismatch',
    'position_closed',
    'duplicate_application',
    'candidate_withdrew',
    'role_filled',
  ],
  requireMembership: mocks.requireMembership,
  moveStage: mocks.moveStage,
  MoveStageSchema: {},
}))
import { POST } from '../route'

const APPLICATION_ID = '1'.repeat(24)

describe('candidate stage command privacy fence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({ workspace: { _id: 'workspace-1' } })
    mocks.moveStage.mockResolvedValue({
      _id: { toString: () => APPLICATION_ID },
      stage: 'rejected',
      decisionNote: 'must-not-leave-the-stage-command',
      events: [{ note: 'must-not-leave-the-stage-command' }],
    })
  })

  it('always rechecks candidate privacy inside the stage transaction', async () => {
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/stage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reject',
            expectedFrom: 'new',
            operationId: '11111111-1111-4111-8111-111111111111',
            reasonCode: 'requirements_mismatch',
          }),
        },
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )

    expect(mocks.moveStage).toHaveBeenCalledWith(
      expect.anything(),
      APPLICATION_ID,
      {
        action: 'reject',
        expectedFrom: 'new',
        operationId: '11111111-1111-4111-8111-111111111111',
        note: 'Decision reason: Requirements mismatch',
        requirePrivacyAvailable: true,
      },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      application: { id: APPLICATION_ID, stage: 'rejected' },
    })
  })

  it('never forwards a client-controlled reason label', async () => {
    await POST(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/stage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'withdraw',
            expectedFrom: 'screened',
            operationId: '22222222-2222-4222-8222-222222222222',
            reasonCode: 'candidate_withdrew',
          }),
        },
      ) as never,
      { params: { appId: APPLICATION_ID } },
    )

    expect(mocks.moveStage).toHaveBeenLastCalledWith(
      expect.anything(),
      APPLICATION_ID,
      expect.objectContaining({
        note: 'Decision reason: Candidate withdrew',
        requirePrivacyAvailable: true,
      }),
    )
  })
})
