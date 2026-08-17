import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  issueApplyLink: vi.fn(),
  disableApplyLink: vi.fn(),
  recoverApplyLink: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
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
  issueApplyLink: mocks.issueApplyLink,
  disableApplyLink: mocks.disableApplyLink,
  recoverApplyLink: mocks.recoverApplyLink,
}))

import { DELETE, GET, POST } from '../route'

const JOB_ID = '222222222222222222222222'
const CAPABILITY = '111111111111111111111111.' + 'a'.repeat(64)
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

describe('/api/workspace/jobs/[jobId]/apply-link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.issueApplyLink.mockResolvedValue({ capability: CAPABILITY })
    mocks.recoverApplyLink.mockResolvedValue(CAPABILITY)
  })

  it('returns the active URL capability only to an authenticated workspace member and never caches it', async () => {
    const response = await GET(
      new Request(`https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/apply-link`) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ capability: CAPABILITY })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.recoverApplyLink).toHaveBeenCalledWith(ctx, JOB_ID)
  })

  it('returns a newly minted capability no-store', async () => {
    const response = await POST(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/apply-link`,
        { method: 'POST' },
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ capability: CAPABILITY, enabled: true })
    expect(mocks.issueApplyLink).toHaveBeenCalledWith(ctx, JOB_ID)
  })

  it('keeps the disabled state response private as well', async () => {
    const response = await DELETE(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/apply-link`,
        { method: 'DELETE' },
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ enabled: false })
    expect(mocks.disableApplyLink).toHaveBeenCalledWith(ctx, JOB_ID)
  })
})
