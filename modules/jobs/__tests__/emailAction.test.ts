import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/jobs/email-action (EMAILS.md §4) — one-tap status claims from E1.
 * Real signed tokens (stubbed EMAIL_TOKEN_SECRET) so type/expiry/purpose
 * separation is exercised for real; models and the transition service are
 * mocked. Invariants: [Nothing yet] never flips status; the stale-guard
 * blocks only USER transitions made after the send; system auto-ghosts
 * never block a claim; every commit routes through transitionStatus with
 * channel 'email'.
 */

const {
  mockAppFindOne,
  mockAppUpdateOne,
  mockSendFindOne,
  mockTransition,
  mockCheckJobsRateLimit,
  mockIsJobsAccountActive,
  mockWithActiveJobsAccountWrite,
} = vi.hoisted(() => ({
  mockAppFindOne: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockSendFindOne: vi.fn(),
  mockTransition: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  JobApplication: { findOne: mockAppFindOne, updateOne: mockAppUpdateOne },
  JobsEmailSend: { findOne: mockSendFindOne },
}))
vi.mock('@jobs', () => ({ transitionStatus: mockTransition }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
      this.name = 'JobsAccountInactiveError'
    }
  },
}))

import { GET, POST } from '../../../app/api/jobs/email-action/route'
import { mintActionToken } from '@shared/services/signedActionToken'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })

const SENT_AT = new Date('2026-07-15T04:00:00Z')
const appDoc = (over: Record<string, unknown> = {}) => ({
  jobPostingId: 'j1',
  status: 'applied',
  statusHistory: [{ status: 'applied', at: new Date('2026-07-01T00:00:00Z'), source: 'user' }],
  outcome: {},
  ...over,
})

const tok = (action: string, over: Record<string, unknown> = {}) =>
  mintActionToken({ typ: 'status', uid: 'u1', aid: 'app1', action, dk: 'app1', expDays: 30, ...over })

const req = (token: string) => new Request(`http://x/api/jobs/email-action?token=${encodeURIComponent(token)}`, { method: 'POST' })

beforeEach(() => {
  vi.stubEnv('EMAIL_TOKEN_SECRET', 'test-secret-for-email-action')
  vi.clearAllMocks()
  mockAppFindOne.mockReturnValue(selectLean(appDoc()))
  mockAppUpdateOne.mockResolvedValue({})
  mockSendFindOne.mockReturnValue(selectLean({ sentAt: SENT_AT }))
  mockTransition.mockResolvedValue({ ok: true, status: 'interview_scheduled', from: 'applied' })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockWithActiveJobsAccountWrite.mockImplementation(async (
    _userId: string,
    work: (session: { id: string }) => Promise<unknown>,
  ) => work({ id: 'email-action-session' }))
})

describe('email-action route', () => {
  it('rate-limits only after token verification and preserves the HTML response contract', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '3600' },
    }))

    const response = await POST(req(tok('rejected')))

    expect(response.status).toBe(429)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Retry-After')).toBe('3600')
    expect(await response.text()).toContain('Too many update attempts')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith('u1', 'email-action')
    expect(mockAppFindOne).not.toHaveBeenCalled()
  })

  it('rejects invalid, expired, and wrong-purpose tokens without touching state', async () => {
    expect((await POST(req('garbage.token'))).status).toBe(200) // friendly page, no mutation
    const unsub = mintActionToken({ typ: 'unsub', uid: 'u1', action: 'e1', expDays: 30 })
    const res = await POST(req(unsub))
    expect(await res.text()).toContain("isn't valid")
    const expired = mintActionToken({ typ: 'status', uid: 'u1', aid: 'app1', action: 'rejected', dk: 'app1', expDays: -1 })
    expect(await (await POST(req(expired))).text()).toContain("isn't valid")
    expect(mockTransition).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('renders the friendly invalid-link page without reading tracker data for an inactive account', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)

    const response = await POST(req(tok('rejected')))

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain("isn't valid")
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('GET renders a confirm form and never mutates (mail scanners are robots)', async () => {
    const res = await GET(req(tok('interview_scheduled')))
    const html = await res.text()
    expect(html).toContain('<form method="POST"')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(mockTransition).not.toHaveBeenCalled()
    // No personal/job data on the confirm page.
    expect(html).not.toContain('Acme')
  })

  it('[Got an interview] routes through the single emitter with channel email and continues to the date sheet', async () => {
    const res = await POST(req(tok('interview_scheduled')))
    expect(mockTransition).toHaveBeenCalledWith('u1', 'j1', 'interview_scheduled', { channel: 'email' })
    expect(await res.text()).toContain('/jobs/j1')
  })

  it('[Nothing yet] is an ANSWER: outcome touch only, never a status flip', async () => {
    await POST(req(tok('nothing-yet')))
    expect(mockTransition).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('u1', expect.any(Function))
    expect(mockAppUpdateOne).toHaveBeenCalledWith(
      { _id: 'app1', userId: 'u1' },
      { $set: { 'outcome.lastAskedAt': expect.any(Date) } },
      { session: { id: 'email-action-session' } },
    )
  })

  it('returns 401 when deletion lands while reading the token-owned application', async () => {
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(req(tok('nothing-yet')))

    expect(response.status).toBe(401)
    expect(await response.text()).toContain("isn't valid")
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(2)
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('[Nothing yet] returns 401 when deletion owns the transactional write fence', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    const response = await POST(req(tok('nothing-yet')))

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain("isn't valid")
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('returns 401 when deletion lands during the stale-action ledger read', async () => {
    mockAppFindOne.mockReturnValue(selectLean(appDoc({
      statusHistory: [
        { status: 'applied', at: new Date('2026-07-01T00:00:00Z'), source: 'user' },
        { status: 'offer', at: new Date('2026-07-16T00:00:00Z'), source: 'user' },
      ],
    })))
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(req(tok('rejected')))

    expect(response.status).toBe(401)
    expect(await response.text()).toContain("isn't valid")
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('keeps the friendly invalid-link contract when deletion wins the transition fence', async () => {
    mockTransition.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    const response = await POST(req(tok('rejected')))

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain("isn't valid")
  })

  it('stale-guard: a USER transition after the send blocks the token', async () => {
    mockAppFindOne.mockReturnValue(selectLean(appDoc({
      statusHistory: [
        { status: 'applied', at: new Date('2026-07-01T00:00:00Z'), source: 'user' },
        { status: 'offer', at: new Date('2026-07-16T00:00:00Z'), source: 'user' }, // after SENT_AT
      ],
    })))
    const res = await POST(req(tok('rejected')))
    expect(await res.text()).toContain('already ahead')
    expect(mockTransition).not.toHaveBeenCalled()
  })

  it('a SYSTEM auto-ghost after the send never blocks — the user claim wins (DECISIONS #20)', async () => {
    mockAppFindOne.mockReturnValue(selectLean(appDoc({
      status: 'ghosted',
      statusHistory: [
        { status: 'applied', at: new Date('2026-07-01T00:00:00Z'), source: 'user' },
        { status: 'ghosted', at: new Date('2026-07-16T00:00:00Z'), source: 'system' }, // after SENT_AT
      ],
    })))
    await POST(req(tok('interview_scheduled')))
    expect(mockTransition).toHaveBeenCalledWith('u1', 'j1', 'interview_scheduled', { channel: 'email' })
  })
})
