import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  retry: vi.fn(),
}))

vi.mock('../../../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => (
    request: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(request, {
    user: { id: 'member-user', email: 'hr@example.com' },
    body: {},
    params: context?.params ?? {},
  }),
}))
vi.mock('@hire', () => ({ requireMembership: mocks.requireMembership }))
vi.mock('@modules/hire-multimodal/services/analysisRecoveryService', () => ({
  retryFailedHireMultimodalAnalysis: mocks.retry,
}))

import { POST } from '../route'

const WORKSPACE_ID = '1'.repeat(24)
const MEMBER_ID = '2'.repeat(24)
const APPLICATION_ID = '3'.repeat(24)
const ANALYSIS_ID = '4'.repeat(24)

describe('POST Hire multimodal analysis retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue({
      workspace: { _id: { toString: () => WORKSPACE_ID } },
      membership: { _id: { toString: () => MEMBER_ID } },
    })
    mocks.retry.mockResolvedValue({ outcome: 'requeued', dispatch: 'sent' })
  })

  it('derives workspace and member authority server-side for the exact application analysis', async () => {
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/applications/${APPLICATION_ID}/multimodal-analysis/${ANALYSIS_ID}/retry`,
        { method: 'POST' },
      ) as never,
      { params: { appId: APPLICATION_ID, analysisId: ANALYSIS_ID } },
    )

    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'member-user',
      email: 'hr@example.com',
    })
    expect(mocks.retry).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      authorityMemberId: MEMBER_ID,
      applicationId: APPLICATION_ID,
      analysisId: ANALYSIS_ID,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      outcome: 'requeued',
      dispatch: 'sent',
    })
  })
})
