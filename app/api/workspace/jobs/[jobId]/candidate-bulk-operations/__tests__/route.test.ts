import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  readSelection: vi.fn(),
  createOperation: vi.fn(),
}))

vi.mock('../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) =>
    async (req: Request, context?: { params?: Record<string, string> }) =>
      options.handler(req, {
        user: { id: 'member-1', email: 'hr@example.com' },
        body: options.schema ? options.schema.parse(await req.json()) : {},
        params: context?.params ?? {},
      }),
}))
vi.mock('@hire', () => ({ requireMembership: mocks.requireMembership }))
vi.mock('@hire-operations', () => ({
  readCandidateSelectionSnapshot: mocks.readSelection,
}))
vi.mock('@/modules/hire-candidate-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/hire-candidate-actions')>()
  return {
    ...actual,
    createHireCandidateBulkOperation: mocks.createOperation,
  }
})

import { POST } from '../route'

const JOB_ID = '111111111111111111111111'
const SELECTION_ID = '222222222222222222222222'
const CLIENT_OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ctx = {
  workspace: { _id: '333333333333333333333333' },
  membership: { _id: '444444444444444444444444', name: 'Ada Recruiter' },
}

describe('POST candidate bulk operation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.createOperation.mockResolvedValue({
      operationId: '555555555555555555555555',
      status: 'queued',
      totalCount: 1000,
    })
  })

  it('accepts only a snapshot coordinate and returns private 202 progress', async () => {
    const body = {
      selectionId: SELECTION_ID,
      clientOperationId: CLIENT_OPERATION_ID,
      action: 'advance',
      expectedStage: 'screened',
      communication: 'none',
      confirmed: true,
      confirmedCount: 1000,
    }
    const response = await POST(
      new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-bulk-operations`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: { jobId: JOB_ID } },
    )

    expect(response.status).toBe(202)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.createOperation).toHaveBeenCalledWith(
      ctx,
      { ...body, jobId: JOB_ID },
      mocks.readSelection,
    )
    await expect(response.json()).resolves.toEqual({
      operation: {
        operationId: '555555555555555555555555',
        status: 'queued',
        totalCount: 1000,
      },
    })
  })

  it('preserves the client replay coordinate and serializes the same partial result', async () => {
    const body = {
      selectionId: SELECTION_ID,
      clientOperationId: CLIENT_OPERATION_ID,
      action: 'advance',
      expectedStage: 'screened',
      communication: 'none',
      confirmed: true,
      confirmedCount: 1000,
    }
    const partialOperation = {
      operationId: '555555555555555555555555',
      status: 'partial',
      totalCount: 1000,
      queuedCount: 0,
      processingCount: 0,
      succeededCount: 994,
      conflictCount: 5,
      failedCount: 1,
    }
    mocks.createOperation.mockResolvedValue(partialOperation)

    const invoke = () =>
      POST(
        new Request(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-bulk-operations`,
          { method: 'POST', body: JSON.stringify(body) },
        ) as never,
        { params: { jobId: JOB_ID } },
      )
    const first = await invoke()
    const replay = await invoke()

    expect(first.status).toBe(202)
    expect(replay.status).toBe(202)
    expect(first.headers.get('Cache-Control')).toBe('private, no-store')
    expect(replay.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(first.json()).resolves.toEqual({ operation: partialOperation })
    await expect(replay.json()).resolves.toEqual({ operation: partialOperation })
    expect(mocks.createOperation).toHaveBeenCalledTimes(2)
    expect(mocks.createOperation).toHaveBeenNthCalledWith(
      1,
      ctx,
      { ...body, jobId: JOB_ID },
      mocks.readSelection,
    )
    expect(mocks.createOperation).toHaveBeenNthCalledWith(
      2,
      ctx,
      { ...body, jobId: JOB_ID },
      mocks.readSelection,
    )
  })

  it('rejects bulk offer outcomes before invoking mutation authority', async () => {
    await expect(
      POST(
        new Request(`https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-bulk-operations`, {
          method: 'POST',
          body: JSON.stringify({
            selectionId: SELECTION_ID,
            clientOperationId: CLIENT_OPERATION_ID,
            action: 'offer_accepted',
            communication: 'none',
            confirmed: true,
            confirmedCount: 1,
          }),
        }) as never,
        { params: { jobId: JOB_ID } },
      ),
    ).rejects.toThrow()
    expect(mocks.createOperation).not.toHaveBeenCalled()
  })
})
