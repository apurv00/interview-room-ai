import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  addOrMergeJobCandidate: vi.fn(),
  serializeCandidate: vi.fn(),
  serializeApplication: vi.fn(),
  parseParams: vi.fn(),
  parseQuery: vi.fn(),
  readCandidates: vi.fn(),
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

vi.mock('@hire-operations', () => ({
  HireOperationsJobParamsSchema: { parse: mocks.parseParams },
  HireJobCandidatesQuerySchema: { parse: mocks.parseQuery },
  readHireJobCandidates: mocks.readCandidates,
}))

import { GET, POST } from '../route'

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

describe('GET /api/workspace/jobs/[jobId]/candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseParams.mockReturnValue({ jobId: JOB_ID })
    mocks.parseQuery.mockReturnValue({
      view: 'all',
      stage: [],
      source: [],
      scoreState: [],
      humanReview: [],
      aiInterview: [],
      sort: 'attention',
      direction: 'desc',
      limit: 50,
    })
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.readCandidates.mockResolvedValue({ rows: [], pageInfo: { nextCursor: null } })
  })

  it('validates the complete URL query and derives workspace scope from membership', async () => {
    const response = await GET(
      new Request(
        `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/candidates?view=decision_ready&stage=shortlist&limit=50`,
      ) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(mocks.parseParams).toHaveBeenCalledWith({ jobId: JOB_ID })
    expect(mocks.parseQuery).toHaveBeenCalledWith({
      view: 'decision_ready',
      stage: 'shortlist',
      limit: '50',
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.readCandidates).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
      jobId: JOB_ID,
      query: expect.objectContaining({ limit: 50 }),
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('fails closed on an invalid or repeated query before membership access', async () => {
    mocks.parseQuery.mockImplementation(() => {
      throw new Error('invalid candidate query')
    })
    await expect(
      GET(
        new Request(
          `https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/candidates?limit=50&limit=100`,
        ) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toThrow('invalid candidate query')
    expect(mocks.parseQuery).toHaveBeenCalledWith({ limit: ['50', '100'] })
    expect(mocks.requireMembership).not.toHaveBeenCalled()
    expect(mocks.readCandidates).not.toHaveBeenCalled()
  })

  it('preserves the controlled stale-cursor code and 409 status from the read service', async () => {
    mocks.readCandidates.mockRejectedValue(Object.assign(
      new Error('Candidate results changed; refresh the list'),
      { code: 'JOB_CANDIDATES_CURSOR_STALE', statusCode: 409 },
    ))
    await expect(GET(
      new Request(`https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/candidates?cursor=opaque`) as never,
      { params: { jobId: JOB_ID } },
    )).rejects.toMatchObject({ code: 'JOB_CANDIDATES_CURSOR_STALE', statusCode: 409 })
  })
})
