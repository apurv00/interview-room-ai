import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getHireIntakeTask: vi.fn(),
  supplyHireIntakeIdentity: vi.fn(),
}))

vi.mock('../../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute: (options: any) => async (
    request: Request,
    context?: { params?: Record<string, string> },
  ) => {
    const body = options.schema ? options.schema.parse(await request.json()) : {}
    return options.handler(request, {
      user: { id: 'hire-member:workspace.member', email: 'admin@acme.com' },
      body,
      params: context?.params ?? {},
      isPrincipalActive: vi.fn(),
    })
  },
}))

vi.mock('@hire', () => ({
  requireMembership: mocks.requireMembership,
  getHireIntakeTask: mocks.getHireIntakeTask,
  supplyHireIntakeIdentity: mocks.supplyHireIntakeIdentity,
}))

import { GET, PATCH } from '../route'

const JOB_ID = '222222222222222222222222'
const TASK_ID = '444444444444444444444444'
const ctx = {
  workspace: { _id: '111111111111111111111111', name: 'Acme' },
  membership: { _id: '333333333333333333333333', role: 'admin' },
}

const waitingTask = {
  taskId: TASK_ID,
  jobId: JOB_ID,
  source: 'bulk_upload',
  fileName: 'ada.pdf',
  status: 'needs_identity',
  attempts: 1,
  lastError: 'No email address was found in this resume',
  queuedAt: new Date('2026-08-12T09:00:00.000Z'),
  statusChangedAt: new Date('2026-08-12T09:01:00.000Z'),
  needsIdentityAt: new Date('2026-08-12T09:01:00.000Z'),
}

function params() {
  return { params: { jobId: JOB_ID, taskId: TASK_ID } }
}

describe('GET/PATCH /api/workspace/jobs/[jobId]/intake/[taskId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.getHireIntakeTask.mockResolvedValue(waitingTask)
    mocks.supplyHireIntakeIdentity.mockResolvedValue({
      ...waitingTask,
      status: 'queued',
      lastError: undefined,
      needsIdentityAt: undefined,
      statusChangedAt: new Date('2026-08-12T09:02:00.000Z'),
    })
  })

  it('returns only the member-visible, workspace-scoped task view without caching it', async () => {
    const response = await GET(
      new Request(`https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/intake/${TASK_ID}`) as never,
      params(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      task: {
        taskId: TASK_ID,
        status: 'needs_identity',
        lastError: 'No email address was found in this resume',
      },
    })
    expect(mocks.getHireIntakeTask).toHaveBeenCalledWith(ctx, { jobId: JOB_ID, taskId: TASK_ID })
  })

  it('requeues a task with recruiter-confirmed email without accepting a new file', async () => {
    const response = await PATCH(
      new Request(`https://hire.interviewprep.guru/api/workspace/jobs/${JOB_ID}/intake/${TASK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ada Lovelace', email: 'ADA@EXAMPLE.COM' }),
      }) as never,
      params(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({ task: { status: 'queued' } })
    expect(mocks.supplyHireIntakeIdentity).toHaveBeenCalledWith(ctx, {
      jobId: JOB_ID,
      taskId: TASK_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
  })
})
