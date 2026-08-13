import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  addOrMergeJobCandidate: vi.fn(),
  serializeCandidate: vi.fn(),
  serializeApplication: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
      params: context?.params ?? {},
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  addOrMergeJobCandidate: mocks.addOrMergeJobCandidate,
  AddOrMergeJobCandidateSchema: {
    parse: (value: unknown) => value,
  },
}))

vi.mock('../../../../_lib/serialize', () => ({
  serializeCandidate: mocks.serializeCandidate,
  serializeApplication: mocks.serializeApplication,
}))

import { POST } from '../route'

const JOB_ID = '222222222222222222222222'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}
const result = {
  candidate: { _id: 'candidate-1' },
  application: { _id: 'application-1' },
  status: 'reapplied',
  createdCandidate: false,
  createdApplication: false,
  sourceMerged: true,
}

describe('POST /api/workspace/jobs/[jobId]/candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.addOrMergeJobCandidate.mockResolvedValue(result)
    mocks.serializeCandidate.mockReturnValue({ id: 'candidate-1' })
    mocks.serializeApplication.mockReturnValue({ id: 'application-1' })
  })

  it('uses the member-gated job-scoped merge service and keeps response private', async () => {
    const response = await POST(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/candidates`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Jane Candidate',
            email: 'jane@example.com',
            operationId: OPERATION_ID,
          }),
        },
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      status: 'reapplied',
      candidate: { id: 'candidate-1' },
      application: { id: 'application-1' },
      createdCandidate: false,
      createdApplication: false,
      sourceMerged: true,
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.addOrMergeJobCandidate).toHaveBeenCalledWith(ctx, JOB_ID, {
      name: 'Jane Candidate',
      email: 'jane@example.com',
      operationId: OPERATION_ID,
    })
  })

  it('returns a safe, private conflict state for an already rejected card', async () => {
    mocks.addOrMergeJobCandidate.mockResolvedValue({
      ...result,
      status: 'already_considered',
      sourceMerged: false,
    })

    const response = await POST(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/candidates`,
        {
          method: 'POST',
          body: JSON.stringify({ candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa', operationId: OPERATION_ID }),
        },
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      status: 'already_considered',
      createdApplication: false,
    })
  })
})
