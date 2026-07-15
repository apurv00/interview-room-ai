import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Email wave PR-A infra: the JobsEmailConfig admin sub-route (own handler,
 * own strict allowlist — EMAILS.md §2 guard 4 / review R29), the
 * getConfig() safe-OFF defaults, and the sendEmail reshape ({ok, id?} +
 * headers/replyTo/idempotencyKey passthrough — review R31).
 */

const { mockGetServerSession, mockGetConfig, mockUpdateOne, mockAggregate, mockCount, mockResendSend } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetConfig: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockAggregate: vi.fn(),
  mockCount: vi.fn(),
  mockResendSend: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  JobsEmailConfig: { getConfig: mockGetConfig, updateOne: mockUpdateOne },
  JobsEmailSend: { aggregate: mockAggregate, countDocuments: mockCount },
  JOBS_EMAIL_STREAMS: ['e0', 'e1', 'e2', 'e3', 'e4'],
}))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockResendSend }
  },
}))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, PATCH } from '../../app/api/cms/jobs-ingest/email/route'
import { JOBS_EMAIL_DEFAULTS } from '../db/models/JobsEmailConfig'

const asAdmin = () => mockGetServerSession.mockResolvedValue({ user: { role: 'platform_admin' } })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetConfig.mockResolvedValue({ ...JOBS_EMAIL_DEFAULTS })
  mockUpdateOne.mockResolvedValue({})
  mockAggregate.mockResolvedValue([{ _id: 'e2', n: 4 }])
  mockCount.mockResolvedValue(0)
})

describe('JobsEmailConfig defaults', () => {
  it('every stream ships OFF — deploys are inert until a founder flip', () => {
    expect(JOBS_EMAIL_DEFAULTS).toEqual({
      e0Enabled: false, e1Enabled: false, e2Enabled: false, e3Enabled: false, e4Enabled: false,
      globalWeeklyCap: 3,
    })
  })
})

describe('/api/cms/jobs-ingest/email', () => {
  it('gates on platform_admin: 401 anon, 403 wrong role', async () => {
    mockGetServerSession.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    mockGetServerSession.mockResolvedValue({ user: { role: 'candidate' } })
    expect((await PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }))).status).toBe(403)
  })

  it('GET returns config + per-stream sent counts + stale reservations', async () => {
    asAdmin()
    const res = await GET()
    const body = await res.json()
    expect(body.config.e2Enabled).toBe(false)
    expect(body.sentByStream).toEqual({ e0: 0, e1: 0, e2: 4, e3: 0, e4: 0 })
    expect(body.staleReservations).toBe(0)
  })

  it('PATCH strict allowlist: unknown keys and wrong types are 400, never silently dropped', async () => {
    asAdmin()
    const bad = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e9Enabled: true }) }))
    expect(bad.status).toBe(400)
    expect(mockUpdateOne).not.toHaveBeenCalled()

    const badType = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: 'yes' }) }))
    expect(badType.status).toBe(400)

    const badCap = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ globalWeeklyCap: 99 }) }))
    expect(badCap.status).toBe(400)

    const empty = await PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }))
    expect(empty.status).toBe(400)
  })

  it('PATCH accepts valid switches and upserts the KEYED singleton (Codex #531 — never an empty filter)', async () => {
    asAdmin()
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: true, globalWeeklyCap: 2 }) }))
    expect(res.status).toBe(200)
    expect(mockUpdateOne).toHaveBeenCalledWith({ key: 'singleton' }, { $set: { e2Enabled: true, globalWeeklyCap: 2 } }, { upsert: true })
  })

  it('PATCH losing a concurrent first-insert race (E11000) retries against the winner doc', async () => {
    asAdmin()
    mockUpdateOne
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
      .mockResolvedValueOnce({})
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ e2Enabled: true }) }))
    expect(res.status).toBe(200)
    expect(mockUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockUpdateOne.mock.calls[1]).toEqual([{ key: 'singleton' }, { $set: { e2Enabled: true } }])
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
