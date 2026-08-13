import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  reengagePoolCandidate: vi.fn(),
}))

vi.mock('../../../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    req: Request,
    context?: { params?: Record<string, string> },
  ) => {
    const body = options.schema ? options.schema.parse(await req.json()) : {}
    return options.handler(req, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.example' },
      body,
      params: context?.params ?? {},
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  reengagePoolCandidate: mocks.reengagePoolCandidate,
  ReengagePoolCandidateSchema: { parse: (value: unknown) => value },
}))

import { POST } from '../route'

const JOB_ID = '222222222222222222222222'
const CANDIDATE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

describe('POST /api/workspace/jobs/[jobId]/pool-suggestions/[candidateId]/reengage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.reengagePoolCandidate.mockResolvedValue({
      status: 'queued',
      candidateId: CANDIDATE_ID,
      applicationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    })
  })

  it('requires the explicit HR confirmation body and keeps the result private', async () => {
    const response = await POST(
      new Request(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/pool-suggestions/${CANDIDATE_ID}/reengage`,
        { method: 'POST', body: JSON.stringify({ operationId: OPERATION_ID }) },
      ) as never,
      { params: { jobId: JOB_ID, candidateId: CANDIDATE_ID } },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      status: 'queued',
      candidateId: CANDIDATE_ID,
      applicationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    })
    expect(mocks.reengagePoolCandidate).toHaveBeenCalledWith(ctx, JOB_ID, {
      candidateId: CANDIDATE_ID,
      operationId: OPERATION_ID,
    })
  })

  it('returns a private conflict when confirmation is no longer allowed', async () => {
    mocks.reengagePoolCandidate.mockResolvedValue({
      status: 'opted_out',
      candidateId: CANDIDATE_ID,
    })
    const response = await POST(
      new Request('https://hire.example/reengage', {
        method: 'POST', body: JSON.stringify({ operationId: OPERATION_ID }),
      }) as never,
      { params: { jobId: JOB_ID, candidateId: CANDIDATE_ID } },
    )

    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({ status: 'opted_out' })
  })
})
