import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  listJobPoolSuggestions: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => options.handler(req, {
    user: { id: 'hire-member:workspace.member', email: 'admin@acme.example' },
    body: {},
    params: context?.params ?? {},
  }),
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  listJobPoolSuggestions: mocks.listJobPoolSuggestions,
}))

import { GET } from '../route'

const JOB_ID = '222222222222222222222222'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

describe('GET /api/workspace/jobs/[jobId]/pool-suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.listJobPoolSuggestions.mockResolvedValue([
      {
        candidate: { id: 'candidate-1', name: 'Ada', email: 'ada@example.com' },
        matchScore: 80,
        matchedRequirements: ['TypeScript'],
        previouslySeenIn: [],
      },
    ])
  })

  it('uses the member boundary, returns only the private read model, and makes no mutation', async () => {
    const response = await GET(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/pool-suggestions`) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      suggestions: [
        {
          candidate: { id: 'candidate-1', name: 'Ada', email: 'ada@example.com' },
          matchScore: 80,
          matchedRequirements: ['TypeScript'],
          previouslySeenIn: [],
        },
      ],
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.example',
    })
    expect(mocks.listJobPoolSuggestions).toHaveBeenCalledWith(ctx, JOB_ID)
  })
})
