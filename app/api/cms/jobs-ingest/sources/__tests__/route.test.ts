import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockSourceOperationError,
  mockOperateJobSource,
  mockRequireCurrentPlatformAdmin,
  mockCheckJobsRateLimit,
} = vi.hoisted(() => {
  class TestSourceOperationError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly status: number,
      public readonly currentControlRevision?: number,
      public readonly currentOperationalRevision?: number,
    ) {
      super(message)
      this.name = 'SourceOperationError'
    }
  }
  return {
    MockSourceOperationError: TestSourceOperationError,
    mockOperateJobSource: vi.fn(),
    mockRequireCurrentPlatformAdmin: vi.fn(),
    mockCheckJobsRateLimit: vi.fn(),
  }
})

vi.mock('@jobs/services/adminAuth', () => ({
  requireCurrentPlatformAdmin: (...args: unknown[]) => mockRequireCurrentPlatformAdmin(...args),
}))
vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: (...args: unknown[]) => mockCheckJobsRateLimit(...args),
}))
vi.mock('@jobs/services/sourceOperations', () => ({
  operateJobSource: (...args: unknown[]) => mockOperateJobSource(...args),
  SourceOperationError: MockSourceOperationError,
}))

import { POST } from '../route'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'

function request(body: unknown, operationId: string | null = OPERATION_ID): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (operationId) headers['idempotency-key'] = operationId
  return new Request('http://localhost/api/cms/jobs-ingest/sources', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckJobsRateLimit.mockResolvedValue(undefined)
  mockRequireCurrentPlatformAdmin.mockImplementation(async (
    options?: { beforeAuthorityLookup?: (actorUserId: string) => Promise<unknown> },
  ) => {
    await options?.beforeAuthorityLookup?.(ACTOR_ID)
    return { ok: true, actorUserId: ACTOR_ID }
  })
  mockOperateJobSource.mockResolvedValue({
    operationId: OPERATION_ID,
    action: 'pause',
    sourceId: 'jsearch',
    controlRevision: 2,
    operationalRevision: 8,
    idempotent: false,
  })
})

describe('POST /api/cms/jobs-ingest/sources', () => {
  it('requires a UUID idempotency key before accepting a command', async () => {
    const response = await POST(request({ action: 'bootstrap' }, null))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })

  it('rate-limits the authenticated identity before authority lookup completes', async () => {
    await POST(request({ action: 'bootstrap' }))

    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(ACTOR_ID, 'admin-command')
  })

  it('passes both legal and operational revisions to the audited service', async () => {
    const response = await POST(request({
      action: 'pause',
      sourceId: 'jsearch',
      expectedControlRevision: 2,
      expectedOperationalRevision: 7,
      reason: 'Maintenance window',
    }))

    expect(response.status).toBe(200)
    expect(mockOperateJobSource).toHaveBeenCalledWith({
      action: 'pause',
      sourceId: 'jsearch',
      expectedControlRevision: 2,
      expectedOperationalRevision: 7,
      reason: 'Maintenance window',
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
    })
  })

  it('reports queued truth for dispatch commands', async () => {
    mockOperateJobSource.mockResolvedValue({
      operationId: OPERATION_ID,
      action: 'run-now',
      sourceId: 'jsearch',
      dispatched: true,
      idempotent: false,
    })

    const response = await POST(request({
      action: 'run-now',
      sourceId: 'jsearch',
      expectedControlRevision: 2,
      expectedOperationalRevision: 7,
    }))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true })
  })

  it('returns both current revisions on an optimistic-concurrency conflict', async () => {
    mockOperateJobSource.mockRejectedValue(new MockSourceOperationError(
      'source changed during the operation',
      'SOURCE_OPERATION_CONFLICT',
      409,
      3,
      8,
    ))

    const response = await POST(request({
      action: 'pause',
      sourceId: 'jsearch',
      expectedControlRevision: 2,
      expectedOperationalRevision: 7,
      reason: 'Maintenance window',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'SOURCE_OPERATION_CONFLICT',
      currentControlRevision: 3,
      currentOperationalRevision: 8,
    })
  })

  it('rejects attempts to edit deploy-reviewed source identity', async () => {
    const response = await POST(request({
      action: 'update-settings',
      sourceId: 'jsearch',
      expectedControlRevision: 2,
      expectedOperationalRevision: 7,
      reason: 'Rename for operations',
      settings: { displayName: 'Mutable provider name' },
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_SOURCE_OPERATION' })
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })
})
