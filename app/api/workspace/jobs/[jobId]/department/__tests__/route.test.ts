import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  updateJobDepartment: vi.fn(),
  serializeJob: vi.fn(),
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
  updateJobDepartment: mocks.updateJobDepartment,
  UpdateJobDepartmentSchema: { parse: (value: unknown) => value },
}))

vi.mock('../../../../_lib/serialize', () => ({
  serializeJob: mocks.serializeJob,
}))

import { PATCH } from '../route'

const JOB_ID = '222222222222222222222222'
const DEPARTMENT_ID = '333333333333333333333333'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '444444444444444444444444', role: 'admin' },
}

describe('PATCH /api/workspace/jobs/[jobId]/department', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.updateJobDepartment.mockResolvedValue({ _id: JOB_ID, departmentId: DEPARTMENT_ID })
    mocks.serializeJob.mockReturnValue({ id: JOB_ID, departmentId: DEPARTMENT_ID })
  })

  it('routes a department reassignment through the job service and serializes the result', async () => {
    const response = await PATCH(
      new Request(`https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/department`, {
        method: 'PATCH',
        body: JSON.stringify({ departmentId: DEPARTMENT_ID }),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job: { id: JOB_ID, departmentId: DEPARTMENT_ID },
    })
    expect(mocks.requireMembership).toHaveBeenCalledWith({
      userId: 'hire-member:workspace.member',
      email: 'admin@acme.com',
    })
    expect(mocks.updateJobDepartment).toHaveBeenCalledWith(ctx, JOB_ID, {
      departmentId: DEPARTMENT_ID,
    })
    expect(mocks.serializeJob).toHaveBeenCalledWith({ _id: JOB_ID, departmentId: DEPARTMENT_ID })
  })
})
