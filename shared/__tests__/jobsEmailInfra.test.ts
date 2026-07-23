import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Email wave PR-A infra: the JobsEmailConfig admin sub-route (own handler,
 * own strict allowlist — EMAILS.md §2 guard 4 / review R29), the
 * getConfig() safe-OFF defaults, and the sendEmail reshape ({ok, id?} +
 * headers/replyTo/idempotencyKey passthrough — review R31).
 */

const {
  mockRequireCurrentPlatformAdmin,
  mockCheckJobsRateLimit,
  mockGetConfig,
  mockConfigUpdateOne,
  mockSendUpdateOne,
  mockAggregate,
  mockCount,
  mockFind,
  mockFindById,
  mockResendSend,
} = vi.hoisted(() => ({
  mockRequireCurrentPlatformAdmin: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockGetConfig: vi.fn(),
  mockConfigUpdateOne: vi.fn(),
  mockSendUpdateOne: vi.fn(),
  mockAggregate: vi.fn(),
  mockCount: vi.fn(),
  mockFind: vi.fn(),
  mockFindById: vi.fn(),
  mockResendSend: vi.fn(),
}))

vi.mock('@jobs/services/adminAuth', () => ({
  requireCurrentPlatformAdmin: (...args: unknown[]) => mockRequireCurrentPlatformAdmin(...args),
}))
vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: (...args: unknown[]) => mockCheckJobsRateLimit(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobsEmailConfig: { getConfig: mockGetConfig, updateOne: mockConfigUpdateOne },
  JobsEmailSend: {
    aggregate: mockAggregate,
    countDocuments: mockCount,
    find: mockFind,
    findById: mockFindById,
    updateOne: mockSendUpdateOne,
  },
}))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockResendSend }
  },
}))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, PATCH, POST } from '../../app/api/cms/jobs-ingest/email/route'
import { JOBS_EMAIL_DEFAULTS } from '../db/models/JobsEmailConfig'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const INCIDENT_ID = '507f191e810c19729de860ea'

function incidentQuery(rows: unknown[]) {
  const lean = vi.fn().mockResolvedValue(rows)
  const select = vi.fn(() => ({ lean }))
  const limit = vi.fn(() => ({ select }))
  const sort = vi.fn(() => ({ limit }))
  return { query: { sort }, sort, limit, select, lean }
}

function existingIncidentQuery(row: unknown) {
  const lean = vi.fn().mockResolvedValue(row)
  const select = vi.fn(() => ({ lean }))
  return { query: { select }, select, lean }
}

function request(body: unknown, method: 'PATCH' | 'POST' = 'POST') {
  return new Request('http://localhost/api/cms/jobs-ingest/email', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockRequireCurrentPlatformAdmin.mockImplementation(async (
    options?: { beforeAuthorityLookup?: (actorUserId: string) => Promise<Response | null> },
  ) => {
    const response = await options?.beforeAuthorityLookup?.(ACTOR_ID)
    if (response) {
      return {
        ok: false,
        status: response.status,
        code: 'REQUEST_BLOCKED',
        error: 'request blocked',
        actorUserId: ACTOR_ID,
        response,
      }
    }
    return { ok: true, actorUserId: ACTOR_ID }
  })
  mockGetConfig.mockResolvedValue({ ...JOBS_EMAIL_DEFAULTS })
  mockConfigUpdateOne.mockResolvedValue({})
  mockSendUpdateOne.mockResolvedValue({ modifiedCount: 1 })
  mockAggregate.mockResolvedValue([{ _id: 'e2', n: 4 }])
  mockCount.mockResolvedValue(0)
  const transactional = incidentQuery([])
  const staleSolicitation = incidentQuery([])
  mockFind
    .mockReturnValueOnce(transactional.query)
    .mockReturnValueOnce(staleSolicitation.query)
})

describe('JobsEmailConfig defaults', () => {
  it('every stream ships OFF — deploys are inert until a founder flip', () => {
    expect(JOBS_EMAIL_DEFAULTS).toEqual({
      e0Enabled: false, e1Enabled: false, e2Enabled: false, e4Enabled: false,
      globalWeeklyCap: 3,
    })
  })
})

describe('/api/cms/jobs-ingest/email', () => {
  it('uses the current-user platform-admin authority check for every operation', async () => {
    mockRequireCurrentPlatformAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'ADMIN_REQUIRED',
      error: 'platform_admin required',
    })

    expect((await GET()).status).toBe(403)
    expect((await PATCH(request({}, 'PATCH'))).status).toBe(403)
    expect((await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'Provider delivery could not be verified',
    }))).status).toBe(403)
    expect(mockRequireCurrentPlatformAdmin).toHaveBeenCalledTimes(3)
    expect(mockAggregate).not.toHaveBeenCalled()
    expect(mockConfigUpdateOne).not.toHaveBeenCalled()
    expect(mockSendUpdateOne).not.toHaveBeenCalled()
  })

  it('GET excludes resolved rows and returns two independently bounded oldest-first incident lists', async () => {
    const transactionalRows = [{
      _id: '507f191e810c19729de860eb',
      userId: '507f1f77bcf86cd799439012',
      stream: 'e0',
      dedupeKey: 'e0/user-1',
      incidentKind: 'delivery-uncertain',
      createdAt: new Date('2026-07-20T08:00:00.000Z'),
    }]
    const solicitationRows = [{
      _id: '507f191e810c19729de860ec',
      userId: '507f1f77bcf86cd799439013',
      stream: 'e4',
      dedupeKey: 'e4/user-2/2026-07-19',
      createdAt: new Date('2026-07-19T08:00:00.000Z'),
    }]
    const transactional = incidentQuery(transactionalRows)
    const staleSolicitation = incidentQuery(solicitationRows)
    mockFind.mockReset()
    mockFind
      .mockReturnValueOnce(transactional.query)
      .mockReturnValueOnce(staleSolicitation.query)
    mockCount.mockResolvedValueOnce(1).mockResolvedValueOnce(2)

    const res = await GET()
    const body = await res.json()

    expect(body.config.e2Enabled).toBe(false)
    expect(body.sentByStream).toEqual({ e0: 0, e1: 0, e2: 4, e4: 0 })
    expect(body.staleReservations).toBe(1)
    expect(body.unstampedTransactional).toBe(2)
    expect(body.incidents).toEqual({
      transactional: [{
        id: '507f191e810c19729de860eb',
        userId: '507f1f77bcf86cd799439012',
        stream: 'e0',
        dedupeKey: 'e0/user-1',
        incidentKind: 'delivery-uncertain',
        createdAt: '2026-07-20T08:00:00.000Z',
      }],
      staleSolicitation: [{
        id: '507f191e810c19729de860ec',
        userId: '507f1f77bcf86cd799439013',
        stream: 'e4',
        dedupeKey: 'e4/user-2/2026-07-19',
        createdAt: '2026-07-19T08:00:00.000Z',
      }],
    })

    expect(mockAggregate.mock.calls[0][0][0].$match).toEqual({
      sentAt: { $exists: true },
    })
    const [solicitationQ, transactionalQ] = mockCount.mock.calls.map((c) => c[0])
    expect(solicitationQ.stream).toEqual({ $in: ['e1', 'e3', 'e4'] })
    expect(solicitationQ.operatorResolution).toEqual({ $exists: false })
    expect(solicitationQ.createdAt).toBeDefined()
    expect(transactionalQ.stream).toEqual({ $in: ['e0', 'e2'] })
    expect(transactionalQ.operatorResolution).toEqual({ $exists: false })
    expect(transactionalQ.createdAt).toBeUndefined()

    const [transactionalFilter, solicitationFilter] = mockFind.mock.calls.map((call) => call[0])
    expect(transactionalFilter).toMatchObject({
      stream: { $in: ['e0', 'e2'] },
      sentAt: { $exists: false },
      operatorResolution: { $exists: false },
    })
    expect(transactionalFilter.createdAt).toBeUndefined()
    expect(solicitationFilter).toMatchObject({
      stream: { $in: ['e1', 'e3', 'e4'] },
      sentAt: { $exists: false },
      operatorResolution: { $exists: false },
      createdAt: { $lt: expect.any(Date) },
    })
    expect(transactional.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 })
    expect(staleSolicitation.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 })
    expect(transactional.limit).toHaveBeenCalledWith(20)
    expect(staleSolicitation.limit).toHaveBeenCalledWith(20)
  })

  it('PATCH strict allowlist: unknown keys and wrong types are 400, never silently dropped', async () => {
    const bad = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e9Enabled: true }) }))
    expect(bad.status).toBe(400)
    expect(mockConfigUpdateOne).not.toHaveBeenCalled()

    const badType = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: 'yes' }) }))
    expect(badType.status).toBe(400)

    const retiredStream = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e3Enabled: true }) }))
    expect(retiredStream.status).toBe(400)

    const badCap = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ globalWeeklyCap: 99 }) }))
    expect(badCap.status).toBe(400)

    const empty = await PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }))
    expect(empty.status).toBe(400)
  })

  it('PATCH accepts valid switches and upserts the KEYED singleton (Codex #531 — never an empty filter)', async () => {
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: true, globalWeeklyCap: 2 }) }))
    expect(res.status).toBe(200)
    expect(mockConfigUpdateOne).toHaveBeenCalledWith({ key: 'singleton' }, { $set: { e2Enabled: true, globalWeeklyCap: 2 } }, { upsert: true })
  })

  it('PATCH losing a concurrent first-insert race (E11000) retries against the winner doc', async () => {
    mockConfigUpdateOne
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
      .mockResolvedValueOnce({})
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: true }) }))
    expect(res.status).toBe(200)
    expect(mockConfigUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockConfigUpdateOne.mock.calls[1]).toEqual([{ key: 'singleton' }, { $set: { e2Enabled: true } }])
  })

  it('POST passes an admin-command rate-limit response through unchanged', async () => {
    const blocked = Response.json(
      { error: 'Too many requests', retryAfter: 60 },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
    mockCheckJobsRateLimit.mockResolvedValue(blocked)

    const response = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'Provider delivery could not be verified',
    }))

    expect(response).toBe(blocked)
    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(ACTOR_ID, 'admin-command')
    expect(mockSendUpdateOne).not.toHaveBeenCalled()
  })

  it('POST rejects malformed JSON, unknown keys, invalid IDs, and invalid reasons', async () => {
    const malformed = await POST(request('{', 'POST'))
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({ code: 'INVALID_JSON' })

    const invalidInputs = [
      {
        action: 'closed-without-resend',
        incidentId: INCIDENT_ID,
        reason: 'Long enough reason',
        expectedUpdatedAt: '2026-07-20T00:00:00.000Z',
      },
      {
        action: 'closed-without-resend',
        incidentId: 'not-an-object-id',
        reason: 'Long enough reason',
      },
      {
        action: 'closed-without-resend',
        incidentId: INCIDENT_ID,
        reason: ' short ',
      },
    ]
    for (const input of invalidInputs) {
      const response = await POST(request(input))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVALID_EMAIL_INCIDENT_RESOLUTION',
      })
    }
    expect(mockSendUpdateOne).not.toHaveBeenCalled()
  })

  it('POST atomically closes one eligible unresolved incident without changing delivery truth', async () => {
    const response = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: '  Provider delivery could not be verified  ',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      idempotent: false,
      incidentId: INCIDENT_ID,
    })
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(ACTOR_ID, 'admin-command')
    expect(mockSendUpdateOne).toHaveBeenCalledTimes(1)
    const [filter, update] = mockSendUpdateOne.mock.calls[0]
    expect(filter).toEqual({
      _id: INCIDENT_ID,
      sentAt: { $exists: false },
      operatorResolution: { $exists: false },
      $or: [
        { stream: { $in: ['e0', 'e2'] } },
        {
          stream: { $in: ['e1', 'e3', 'e4'] },
          createdAt: { $lt: expect.any(Date) },
        },
      ],
    })
    expect(update).toEqual({
      $set: {
        operatorResolution: {
          kind: 'closed-without-resend',
          reason: 'Provider delivery could not be verified',
          actorUserId: ACTOR_ID,
          at: expect.any(Date),
        },
      },
    })
    expect(JSON.stringify(update)).not.toContain('sentAt')
    expect(mockFindById).not.toHaveBeenCalled()
  })

  it('POST treats an already-resolved row as an idempotent replay without overwriting it', async () => {
    mockSendUpdateOne.mockResolvedValue({ modifiedCount: 0 })
    const existing = existingIncidentQuery({
      operatorResolution: {
        kind: 'closed-without-resend',
        reason: 'Original operator decision',
      },
    })
    mockFindById.mockReturnValue(existing.query)

    const response = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'Different reason must not replace original',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      idempotent: true,
      incidentId: INCIDENT_ID,
    })
    expect(mockSendUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockFindById).toHaveBeenCalledWith(INCIDENT_ID)
    expect(existing.select).toHaveBeenCalledWith('sentAt operatorResolution')
  })

  it('POST returns conflict for stamped or fresh rows and 404 only when the row is missing', async () => {
    mockSendUpdateOne.mockResolvedValue({ modifiedCount: 0 })

    mockFindById.mockReturnValueOnce(existingIncidentQuery({
      sentAt: new Date('2026-07-20T00:00:00.000Z'),
    }).query)
    const stamped = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'Delivery already has a provider stamp',
    }))
    expect(stamped.status).toBe(409)
    await expect(stamped.json()).resolves.toMatchObject({ code: 'EMAIL_INCIDENT_NOT_RESOLVABLE' })

    mockFindById.mockReturnValueOnce(existingIncidentQuery({}).query)
    const fresh = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'Solicitation reservation is not stale yet',
    }))
    expect(fresh.status).toBe(409)
    await expect(fresh.json()).resolves.toMatchObject({ code: 'EMAIL_INCIDENT_NOT_RESOLVABLE' })

    mockFindById.mockReturnValueOnce(existingIncidentQuery(null).query)
    const missing = await POST(request({
      action: 'closed-without-resend',
      incidentId: INCIDENT_ID,
      reason: 'The selected incident no longer exists',
    }))
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'EMAIL_INCIDENT_NOT_FOUND' })
  })
})

describe('sendEmail reshape (R31)', () => {
  it('returns {ok:true, id} on success and passes headers + idempotencyKey through', async () => {
    vi.stubEnv('RESEND_API_KEY', 'k')
    vi.resetModules()
    const { sendEmail } = await import('../services/emailService')
    mockResendSend.mockResolvedValue({ data: { id: 'resend-123' }, error: null })
    const r = await sendEmail({
      to: 'a@b.c', subject: 's', html: '<p/>',
      headers: { 'List-Unsubscribe': '<https://x/u>' },
      idempotencyKey: 'e2/app1:2026-07-20',
    })
    expect(r).toEqual({ ok: true, id: 'resend-123' })
    const [payload, opts] = mockResendSend.mock.calls[0]
    expect(payload.headers).toEqual({ 'List-Unsubscribe': '<https://x/u>' })
    expect(opts).toEqual({ idempotencyKey: 'e2/app1:2026-07-20' })
    vi.unstubAllEnvs()
  })

  it('returns {ok:false} on provider error and on missing key (no-op path)', async () => {
    vi.stubEnv('RESEND_API_KEY', 'k')
    vi.resetModules()
    const { sendEmail } = await import('../services/emailService')
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'nope' } })
    expect((await sendEmail({ to: 'a@b.c', subject: 's', html: 'h' })).ok).toBe(false)

    vi.stubEnv('RESEND_API_KEY', '')
    vi.resetModules()
    const { sendEmail: sendNoKey } = await import('../services/emailService')
    expect(await sendNoKey({ to: 'a@b.c', subject: 's', html: 'h' })).toEqual({ ok: false })
    vi.unstubAllEnvs()
  })
})
