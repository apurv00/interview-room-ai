import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  getOperation: vi.fn(),
}))

vi.mock('../../../../../_lib/composeHireApiRoute', () => ({
  composeHireApiRoute:
    (options: any) =>
    async (req: Request, context?: { params?: Record<string, string> }) =>
      options.handler(req, {
        user: { id: 'member-1', email: 'hr@example.com' },
        body: {},
        params: context?.params ?? {},
      }),
}))
vi.mock('@hire', () => ({ requireMembership: mocks.requireMembership }))
vi.mock('@/modules/hire-candidate-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/hire-candidate-actions')>()
  return { ...actual, getHireCandidateBulkOperation: mocks.getOperation }
})

import { GET } from '../route'

const JOB_ID = '111111111111111111111111'
const OPERATION_ID = '222222222222222222222222'
const CURSOR = '333333333333333333333333'
const ctx = {
  workspace: { _id: '444444444444444444444444' },
  membership: { _id: '555555555555555555555555' },
}

describe('GET candidate bulk operation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireMembership.mockResolvedValue(ctx)
    mocks.getOperation.mockResolvedValue({
      operation: { operationId: OPERATION_ID, status: 'partial' },
      issues: { items: [], nextCursor: null },
    })
  })

  it('returns a member-scoped, private, cursor-bounded progress page', async () => {
    const response = await GET(
      new NextRequest(
        `https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-bulk-operations/${OPERATION_ID}?limit=25&cursor=${CURSOR}`,
      ) as never,
      { params: { jobId: JOB_ID, operationId: OPERATION_ID } },
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.getOperation).toHaveBeenCalledWith(ctx, {
      jobId: JOB_ID,
      operationId: OPERATION_ID,
      issues: { limit: 25, cursor: CURSOR },
    })
  })

  it('rejects unbounded issue reads before querying the operation', async () => {
    await expect(
      GET(
        new NextRequest(
          `https://hire.example/api/workspace/jobs/${JOB_ID}/candidate-bulk-operations/${OPERATION_ID}?limit=101`,
        ) as never,
        { params: { jobId: JOB_ID, operationId: OPERATION_ID } },
      ),
    ).rejects.toThrow()
    expect(mocks.getOperation).not.toHaveBeenCalled()
  })
})
