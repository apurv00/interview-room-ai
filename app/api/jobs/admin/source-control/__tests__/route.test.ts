import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockConnectDB,
  mockControlJobSource,
  mockGetServerSession,
  mockLoggerError,
  mockLoggerInfo,
  mockLoggerWarn,
  mockUserFindOne,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockControlJobSource: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockUserFindOne: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}))
vi.mock('@shared/db/models', () => ({
  User: { findOne: (...args: unknown[]) => mockUserFindOne(...args) },
}))
vi.mock('@shared/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))
vi.mock('@jobs/services/sourceControl', () => {
  class SourceControlNotFoundError extends Error {
    constructor(sourceId: string) {
      super(`unknown job source: ${sourceId}`)
      this.name = 'SourceControlNotFoundError'
    }
  }

  class SourceControlConflictError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'SourceControlConflictError'
    }
  }

  class SourceControlIntegrityError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'SourceControlIntegrityError'
    }
  }

  class SourceControlCapacityError extends Error {
    constructor(postings: number, limit: number) {
      super(`job source control retained corpus ${postings} exceeds the smoke-proven limit ${limit}`)
      this.name = 'SourceControlCapacityError'
    }
  }

  class SourceTransactionsRequiredError extends Error {
    constructor() {
      super('job source control requires MongoDB replica-set transactions')
      this.name = 'SourceTransactionsRequiredError'
    }
  }

  class SourceLineageMigrationRequiredError extends Error {
    constructor(sourceId: string) {
      super(`job source control requires the durable-lineage repair for ${sourceId}`)
      this.name = 'SourceLineageMigrationRequiredError'
    }
  }

  return {
    controlJobSource: (...args: unknown[]) => mockControlJobSource(...args),
    SourceControlNotFoundError,
    SourceControlConflictError,
    SourceControlIntegrityError,
    SourceControlCapacityError,
    SourceTransactionsRequiredError,
    SourceLineageMigrationRequiredError,
  }
})

import {
  SourceControlCapacityError,
  SourceControlConflictError,
  SourceControlIntegrityError,
  SourceControlNotFoundError,
  SourceLineageMigrationRequiredError,
  SourceTransactionsRequiredError,
} from '@jobs/services/sourceControl'
import { POST } from '../route'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const URL = 'http://localhost/api/jobs/admin/source-control'

const validBody = {
  sourceId: 'gh:phonepe',
  action: 'revoke' as const,
  expectedRevision: 4,
  reason: 'Legal request LEG-1042',
}

function request(body: unknown = validBody, operationId: string | null = OPERATION_ID) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (operationId !== null) headers['idempotency-key'] = operationId
  return new Request(URL, { method: 'POST', headers, body: JSON.stringify(body) })
}

function rawRequest(body: string, operationId: string | null = OPERATION_ID) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (operationId !== null) headers['idempotency-key'] = operationId
  return new Request(URL, { method: 'POST', headers, body })
}

function mockCurrentAdmin(admin: object | null = { _id: ACTOR_ID }) {
  const lean = vi.fn().mockResolvedValue(admin)
  const select = vi.fn().mockReturnValue({ lean })
  mockUserFindOne.mockReturnValue({ select })
  return { select, lean }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockGetServerSession.mockResolvedValue({ user: { id: ACTOR_ID, role: 'platform_admin' } })
  mockCurrentAdmin()
  mockControlJobSource.mockResolvedValue({
    sourceId: validBody.sourceId,
    action: validBody.action,
    previousRevision: validBody.expectedRevision,
    revision: validBody.expectedRevision + 1,
    enabled: false,
    health: 'revoked',
    affectedPostings: 12,
    unknownLineagePostings: 2,
    operationId: OPERATION_ID,
    at: new Date('2026-07-21T10:00:00.000Z'),
    idempotent: false,
  })
})

describe('POST /api/jobs/admin/source-control', () => {
  it('returns 401 without a session and does not touch Mongo', async () => {
    mockGetServerSession.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockUserFindOne).not.toHaveBeenCalled()
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('returns 403 when the session has no authoritative user id', async () => {
    mockGetServerSession.mockResolvedValue({ user: { role: 'platform_admin' } })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockUserFindOne).not.toHaveBeenCalled()
  })

  it('rejects a stale platform_admin JWT after the DB role was removed', async () => {
    mockCurrentAdmin(null)

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mockUserFindOne).toHaveBeenCalledWith({ _id: ACTOR_ID, role: 'platform_admin' })
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('returns a logged retryable 503 when the authoritative role lookup is unavailable', async () => {
    const failure = new Error('Mongo unavailable')
    mockConnectDB.mockRejectedValueOnce(failure)

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'source-control authorization unavailable',
      code: 'AUTHORITY_UNAVAILABLE',
    })
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure, actorUserId: ACTOR_ID }),
      'jobs source-control authorization lookup failed',
    )
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('uses the current DB role even when the JWT role snapshot is stale', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: ACTOR_ID, role: 'candidate' } })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockControlJobSource).toHaveBeenCalledOnce()
  })

  it('rejects malformed JSON before invoking source control', async () => {
    const response = await POST(rawRequest('{'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid JSON' })
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('strictly rejects unknown body keys and invalid command fields', async () => {
    const unknown = await POST(request({ ...validBody, enabled: false }))
    expect(unknown.status).toBe(400)

    const invalid = await POST(request({
      ...validBody,
      sourceId: 'GH PhonePe',
      expectedRevision: 1.5,
      reason: 'short',
    }))
    expect(invalid.status).toBe(400)
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('requires a UUID Idempotency-Key header', async () => {
    const missing = await POST(request(validBody, null))
    expect(missing.status).toBe(400)

    const malformed = await POST(request(validBody, 'not-a-uuid'))
    expect(malformed.status).toBe(400)
    expect(mockControlJobSource).not.toHaveBeenCalled()
  })

  it('passes the validated command, authoritative actor, and idempotency key to the service', async () => {
    const response = await POST(request({ ...validBody, reason: `  ${validBody.reason}  ` }))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(mockControlJobSource).toHaveBeenCalledWith({
      ...validBody,
      actorUserId: ACTOR_ID,
      operationId: OPERATION_ID,
    })
    expect(payload).toMatchObject({
      ok: true,
      result: { revision: 5, affectedPostings: 12, idempotent: false },
    })
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        affectedPostings: 12,
        unknownLineagePostings: 2,
        durationMs: expect.any(Number),
      }),
      'jobs source-control transition committed',
    )
  })

  it.each([
    [new SourceControlNotFoundError(validBody.sourceId), 404],
    [new SourceControlConflictError('stale source revision'), 409],
    [new SourceTransactionsRequiredError(), 503],
    [new SourceLineageMigrationRequiredError(validBody.sourceId), 503],
    [new SourceControlCapacityError(25_001, 25_000), 503],
  ])('maps the source-control error %s to HTTP %i', async (error, status) => {
    mockControlJobSource.mockRejectedValueOnce(error)

    const response = await POST(request())

    expect(response.status).toBe(status)
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('alerts and returns retryable 503 for audit/config integrity drift', async () => {
    const error = new SourceControlIntegrityError('source control integrity failure: audit chain drift')
    mockControlJobSource.mockRejectedValueOnce(error)

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: error.message,
      code: 'SOURCE_CONTROL_INTEGRITY',
    })
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error, sourceId: validBody.sourceId, operationId: OPERATION_ID }),
      'jobs source-control transition blocked by integrity failure',
    )
  })

  it('logs unexpected failures without exposing their message', async () => {
    mockControlJobSource.mockRejectedValueOnce(new Error('database credential leaked'))

    const response = await POST(request())
    const payload = await response.json()

    expect(response.status).toBe(500)
    expect(payload).toEqual({ error: 'source-control transition failed' })
    expect(mockLoggerError).toHaveBeenCalledOnce()
  })
})
