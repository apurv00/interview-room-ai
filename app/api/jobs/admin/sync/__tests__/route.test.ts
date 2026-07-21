import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockSourceOperationError,
  mockCheckJobsRateLimit,
  mockOperateJobSource,
  mockRequireCurrentPlatformAdmin,
  mockSend,
} = vi.hoisted(() => {
  class TestSourceOperationError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly status: 400 | 404 | 409 | 422 | 503,
      public readonly currentControlRevision?: number,
      public readonly currentOperationalRevision?: number,
    ) {
      super(message)
      this.name = 'SourceOperationError'
    }
  }
  return {
    MockSourceOperationError: TestSourceOperationError,
    mockCheckJobsRateLimit: vi.fn(),
    mockOperateJobSource: vi.fn(),
    mockRequireCurrentPlatformAdmin: vi.fn(),
    mockSend: vi.fn(),
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
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...args: unknown[]) => mockSend(...args) },
}))

import { POST } from '../route'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const URL = 'http://localhost/api/jobs/admin/sync'

function request(body: unknown, operationId: string | null = OPERATION_ID) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (operationId) headers['idempotency-key'] = operationId
  return new Request(URL, { method: 'POST', headers, body: JSON.stringify(body) })
}

const sourceCommand = {
  sourceId: 'gh:phonepe',
  expectedControlRevision: 11,
  expectedOperationalRevision: 4,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockRequireCurrentPlatformAdmin.mockImplementation(async (
    options?: { beforeAuthorityLookup?: (actorUserId: string) => Promise<unknown> },
  ) => {
    const response = await options?.beforeAuthorityLookup?.(ACTOR_ID)
    if (response) return {
      ok: false,
      status: (response as Response).status,
      code: 'REQUEST_BLOCKED',
      error: 'request blocked',
      response,
    }
    return { ok: true, actorUserId: ACTOR_ID }
  })
  mockOperateJobSource.mockResolvedValue({
    operationId: OPERATION_ID,
    action: 'run-now',
    sourceId: sourceCommand.sourceId,
    controlRevision: 11,
    operationalRevision: 4,
    dispatched: true,
    idempotent: false,
  })
  mockSend.mockResolvedValue(undefined)
})

describe('POST /api/jobs/admin/sync', () => {
  it('applies the command budget before authority lookup completes', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, { status: 429 }))

    const response = await POST(request(sourceCommand))

    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(ACTOR_ID, 'admin-command')
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })

  it('fails closed when the current database role rejects the caller', async () => {
    mockRequireCurrentPlatformAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'ADMIN_REQUIRED',
      error: 'platform_admin required',
    })

    const response = await POST(request(sourceCommand))

    expect(response.status).toBe(403)
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })

  it('delegates source sync to the audited operation with both revisions', async () => {
    const response = await POST(request(sourceCommand))

    expect(response.status).toBe(202)
    expect(mockOperateJobSource).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      action: 'run-now',
      ...sourceCommand,
    })
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('rejects legacy source kicks without revision fences', async () => {
    const response = await POST(request({ sourceId: sourceCommand.sourceId }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_SOURCE_SYNC' })
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })

  it('requires an idempotency key for source dispatch', async () => {
    const response = await POST(request(sourceCommand, null))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
  })

  it('returns both current revisions on a stale command', async () => {
    mockOperateJobSource.mockRejectedValue(new MockSourceOperationError(
      'source changed',
      'SOURCE_OPERATION_CONFLICT',
      409,
      12,
      5,
    ))

    const response = await POST(request(sourceCommand))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      currentControlRevision: 12,
      currentOperationalRevision: 5,
    })
  })

  it('preserves the separate bounded verdict-sweep command', async () => {
    const response = await POST(request({ mode: 'verdict-sweep', limit: 12.9 }, null))

    expect(response.status).toBe(200)
    expect(mockSend).toHaveBeenCalledWith({ name: 'jobs/verdict.sweep', data: { limit: 12 } })
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    const response = await POST(new Request(URL, { method: 'POST', body: '{' }))

    expect(response.status).toBe(400)
    expect(mockOperateJobSource).not.toHaveBeenCalled()
  })
})
