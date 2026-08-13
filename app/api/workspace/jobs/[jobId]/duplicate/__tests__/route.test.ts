import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  duplicateJob: vi.fn(),
  serializeJob: vi.fn(),
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

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  duplicateJob: mocks.duplicateJob,
}))

vi.mock('../../../../_lib/serialize', () => ({
  serializeJob: mocks.serializeJob,
}))

import { POST } from '../route'

const JOB_ID = '222222222222222222222222'
const CAPABILITY = '111111111111111111111111.' + 'a'.repeat(64)
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}
const duplicated = {
  job: { _id: '444444444444444444444444', title: 'Backend Engineer' },
  capability: CAPABILITY,
}

describe('POST /api/workspace/jobs/[jobId]/duplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.duplicateJob.mockResolvedValue(duplicated)
    mocks.serializeJob.mockReturnValue({
      id: '444444444444444444444444',
      title: 'Backend Engineer',
      applyPageEnabled: true,
    })
  })

  it('duplicates under the authenticated workspace and returns the one-time capability no-store', async () => {
    const response = await POST(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/duplicate`,
        { method: 'POST' },
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      job: {
        id: '444444444444444444444444',
        title: 'Backend Engineer',
        applyPageEnabled: true,
      },
      capability: CAPABILITY,
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.duplicateJob).toHaveBeenCalledWith(ctx, JOB_ID)
    expect(mocks.serializeJob).toHaveBeenCalledWith(duplicated.job, { includeJd: true })
  })
})
