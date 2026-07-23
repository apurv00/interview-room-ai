import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * PR-B — transactional email streams E0 + E2 (EMAILS.md §1/§2/§6).
 * Covers: IST timing math, template honesty rules, the transactional send
 * discipline (send-first + idempotency key, unstamped-row alerting), the
 * E0 handler gates, and the E2 sweep derivation matrix.
 */

const {
  mockGetConfig, mockSendEmail, mockSendFindOne, mockSendCreate, mockSendCount, mockSendUpdateOne,
  mockUserFindById, mockAppFindOne, mockAppFind, mockAppExists, mockPostingFindById, mockPostingExists,
  mockSessionExists, mockInngestSend, mockLoggerError, mockSendUpdateMany, mockAppUpdateMany, mockSendAggregate, mockSendDeleteMany,
  mockPreparePractice, mockIsJobsAccountActive, mockWithActiveJobsAccountWrite, mockDbSession,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
  mockGetConfig: vi.fn(),
  mockSendEmail: vi.fn(),
  mockSendFindOne: vi.fn(),
  mockSendCreate: vi.fn(),
  mockSendCount: vi.fn(),
  mockSendUpdateOne: vi.fn(),
  mockUserFindById: vi.fn(),
  mockAppFindOne: vi.fn(),
  mockAppFind: vi.fn(),
  mockAppExists: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingExists: vi.fn(),
  mockSessionExists: vi.fn(),
  mockInngestSend: vi.fn(),
  mockSendUpdateMany: vi.fn(),
  mockAppUpdateMany: vi.fn(),
  mockSendAggregate: vi.fn(),
  mockSendDeleteMany: vi.fn(),
  mockLoggerError: vi.fn(),
  mockPreparePractice: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
  mockDbSession: { id: 'jobs-account-session' },
  MockJobsAccountInactiveError,
  }
})

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError } }))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockInngestSend, createFunction: vi.fn(() => ({})) },
}))
vi.mock('@shared/services/emailService', () => ({ sendEmail: mockSendEmail }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  activeJobsAccountFilter: (userId: string) => ({
    _id: userId,
    $or: [{ accountState: 'active' }, { accountState: { $exists: false } }],
  }),
  isJobsAccountActive: mockIsJobsAccountActive,
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))
vi.mock('../services/practiceHandoff', () => ({ preparePracticeHandoffPosting: mockPreparePractice }))
vi.mock('@shared/services/signedActionToken', () => ({
  mintActionToken: vi.fn((input: { action: string }) => `tok-${input.action}`),
}))
vi.mock('@shared/db/models', () => ({
  JobsEmailConfig: { getConfig: mockGetConfig },
  JobsEmailSend: { findOne: mockSendFindOne, create: mockSendCreate, countDocuments: mockSendCount, updateOne: mockSendUpdateOne, updateMany: mockSendUpdateMany, aggregate: mockSendAggregate, deleteMany: mockSendDeleteMany },
  User: { findById: mockUserFindById, findOne: mockUserFindById },
  JobApplication: { findOne: mockAppFindOne, find: mockAppFind, exists: mockAppExists, updateMany: mockAppUpdateMany },
  JobPosting: { findById: mockPostingFindById, exists: mockPostingExists },
  InterviewSession: { exists: mockSessionExists },
  ProductEvent: { create: vi.fn().mockResolvedValue({}) },
}))

import { isInSendWindow, nextSendSlot, e2SendInstant, istCalendarDaysBetween, istDateKey } from '../config/emailTiming'
import { BANNED_SUBJECT_PATTERNS } from '../emails/shared'
import { buildE0Email } from '../emails/e0'
import { buildE2Email } from '../emails/e2'
import { buildE1Email, buildE4Email } from '../emails/e1'
import { sendTransactional, isSuppressed } from '../services/emailSendService'
import { runE0Handler, runEmailSweepHandler } from '../jobs/emailJobs'

const step = {
  run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  sleepUntil: vi.fn().mockResolvedValue(undefined),
}
const lean = (v: unknown) => ({ lean: () => Promise.resolve(v), select: function () { return this } })
const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })
const POSTING_UPDATED_AT = new Date('2026-07-21T03:00:00.000Z')
const posting = (over: Record<string, unknown> = {}) => ({
  title: 'Backend Engineer', company: 'Acme', status: 'open', updatedAt: POSTING_UPDATED_AT, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
  )
  mockGetConfig.mockResolvedValue({ e0Enabled: true, e2Enabled: true, globalWeeklyCap: 3 })
  mockSendFindOne.mockReturnValue(lean(null))
  mockSendCreate.mockResolvedValue({})
  mockSendCount.mockResolvedValue(0)
  mockSendUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  mockSendEmail.mockResolvedValue({ ok: true, id: 're-1' })
  mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } } }))
  mockAppExists.mockResolvedValue({ _id: 'app1' })
  mockPostingFindById.mockReturnValue(selectLean(posting()))
  mockPostingExists.mockResolvedValue({ _id: 'j1' })
  mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash', role: 'backend' })
  mockSessionExists.mockResolvedValue(null)
  mockSendUpdateMany.mockResolvedValue({})
  mockAppUpdateMany.mockResolvedValue({})
  mockSendAggregate.mockResolvedValue([])
  mockSendDeleteMany.mockResolvedValue({})
})

// ── Timing math (pure) ───────────────────────────────────────────────────────

describe('emailTiming (IST, fixed offset)', () => {
  it('send window is 08:00–21:00 IST', () => {
    expect(isInSendWindow(new Date('2026-07-20T02:30:00Z'))).toBe(true)  // 08:00 IST
    expect(isInSendWindow(new Date('2026-07-20T02:29:00Z'))).toBe(false) // 07:59 IST
    expect(isInSendWindow(new Date('2026-07-20T15:29:00Z'))).toBe(true)  // 20:59 IST
    expect(isInSendWindow(new Date('2026-07-20T15:30:00Z'))).toBe(false) // 21:00 IST
  })

  it('nextSendSlot: late-night requests land at 08:00 IST next morning', () => {
    // 23:00 IST → next day 08:00 IST (02:30 UTC)
    expect(nextSendSlot(new Date('2026-07-20T17:30:00Z')).toISOString()).toBe('2026-07-21T02:30:00.000Z')
    // 05:00 IST → same day 08:00 IST
    expect(nextSendSlot(new Date('2026-07-19T23:30:00Z')).toISOString()).toBe('2026-07-20T02:30:00.000Z')
    // inside the window → unchanged
    const inWindow = new Date('2026-07-20T05:00:00Z')
    expect(nextSendSlot(inWindow)).toBe(inWindow)
  })

  it('e2SendInstant exact: T-1 09:00 IST; never after the interview day ends', () => {
    const interview = new Date('2026-07-22T00:00:00Z') // IST July 22
    const now = new Date('2026-07-20T00:00:00Z')
    expect(e2SendInstant(interview, now)!.toISOString()).toBe('2026-07-21T03:30:00.000Z') // Jul 21 09:00 IST
    // Past the interview day's end → null
    expect(e2SendInstant(interview, new Date('2026-07-23T00:00:00Z'))).toBeNull()
  })

  it('istCalendarDaysBetween counts IST calendar days', () => {
    // 23:30 IST → 00:30 IST next day = 1 calendar day apart
    expect(istCalendarDaysBetween(new Date('2026-07-20T18:00:00Z'), new Date('2026-07-20T19:00:00Z'))).toBe(1)
  })

  it('istDateKey does not use the previous UTC date after IST midnight', () => {
    expect(istDateKey(new Date('2026-07-20T19:00:00.000Z'))).toBe('2026-07-21')
  })
})

// ── Templates (honesty rules) ────────────────────────────────────────────────

describe('templates', () => {
  const footer = { whyLine: 'you asked for this', unsubscribeStreamUrl: 'https://x/u?s', unsubscribeAllUrl: 'https://x/u?a' }

  it('subjects never impersonate employer contact (banned-pattern list, R9)', () => {
    const subjects = [
      buildE0Email({ company: 'Acme', jobTitle: 'Backend Engineer', practiceUrl: 'https://x/p', footer }).subject,
      buildE2Email({ company: 'Acme', jobTitle: 'Backend Engineer', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/w', logisticsOnly: false, practiceAvailable: true, footer }).subject,
      buildE2Email({ company: 'Acme', jobTitle: 'Backend Engineer', whenLabel: 'this week', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/w', logisticsOnly: true, practiceAvailable: true, footer }).subject,
    ]
    for (const s of subjects) {
      for (const banned of BANNED_SUBJECT_PATTERNS) expect(s).not.toMatch(banned)
    }
  })

  it('every template carries both unsubscribe links and the why-line', () => {
    const { html } = buildE0Email({ company: 'Acme', jobTitle: 'X', practiceUrl: 'https://x/p', footer })
    expect(html).toContain('https://x/u?s')
    expect(html).toContain('https://x/u?a')
    expect(html).toContain('you asked for this')
  })

  it('logistics-only E2 (practiced in last 24h) drops the warm-up push', () => {
    const full = buildE2Email({ company: 'Acme', jobTitle: 'X', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/warm', logisticsOnly: false, practiceAvailable: true, footer })
    const light = buildE2Email({ company: 'Acme', jobTitle: 'X', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/warm', logisticsOnly: true, practiceAvailable: true, footer })
    expect(full.html).toContain('https://x/warm')
    expect(light.html).not.toContain('https://x/warm')
  })

  it('E2 uses a generic setup CTA when exact-posting Practice is unavailable', () => {
    const { html } = buildE2Email({
      company: 'Acme', jobTitle: 'X', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/setup',
      warmUpUrl: 'https://x/must-not-appear', logisticsOnly: false, practiceAvailable: false, footer,
    })
    expect(html).toContain('https://x/setup')
    expect(html).not.toContain('https://x/must-not-appear')
    expect(html).toMatch(/general\s+interview preparation/)
  })

  it('templates escape user-influenced strings', () => {
    const { html } = buildE0Email({ company: '<script>alert(1)</script>', jobTitle: 'X', practiceUrl: 'https://x/p', footer })
    expect(html).not.toContain('<script>')
  })

  it('E1 describes tracker-mark time and E4 makes no unsupported response-speed claim', () => {
    const e1 = buildE1Email({
      rows: [{
        company: 'Acme',
        jobTitle: 'Engineer',
        markedAppliedAgoDays: 14,
        interviewUrl: 'https://x/interview',
        rejectedUrl: 'https://x/rejected',
        nothingYetUrl: 'https://x/waiting',
      }],
      trackerUrl: 'https://x/tracker',
      footer,
    })
    expect(e1.html).toContain('You marked this applied 14 days ago.')
    expect(e1.html).not.toContain('You applied 14 days ago.')

    const e4 = buildE4Email({
      company: 'Acme', jobTitle: 'Engineer', practiceUrl: 'https://x/practice', intent: 'applied', footer,
    })
    expect(e4.html).not.toMatch(/usually comes fast|evidence toward your readiness/i)
    expect(e4.html).toContain('completed practice stays with this tracked job')
  })
})

// ── Transactional send discipline ────────────────────────────────────────────

describe('sendTransactional (EMAILS.md §2)', () => {
  const input = {
    userId: 'u1', stream: 'e2' as const, dedupeKey: 'app1:2026-07-22',
    to: 'u@x.com', subject: 's', html: 'h',
    footer: { whyLine: '', unsubscribeStreamUrl: '', unsubscribeAllUrl: '' },
  }

  it('sends FIRST with the idempotency key, records after', async () => {
    const r = await sendTransactional(input)
    expect(r).toEqual({ outcome: 'sent', resendId: 're-1' })
    expect(mockSendEmail.mock.calls[0][0].idempotencyKey).toBe('e2/app1:2026-07-22')
    expect(mockSendEmail.mock.calls[0][0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(mockSendUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', stream: 'e2', dedupeKey: 'app1:2026-07-22' },
      { $set: { sentAt: expect.any(Date), resendId: 're-1' } },
      { upsert: true, session: mockDbSession },
    )
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('stamps a concurrent unstamped burn winner after a success-upsert E11000 race', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: 11000 })
    mockSendUpdateOne
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })

    expect(await sendTransactional(input)).toEqual({ outcome: 'sent', resendId: 're-1' })
    expect(mockSendEmail).toHaveBeenCalledOnce()
    expect(mockSendUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockSendUpdateOne.mock.calls[0][2]).toEqual({ upsert: true, session: mockDbSession })
    expect(mockSendUpdateOne.mock.calls[1]).toEqual([
      { userId: 'u1', stream: 'e2', dedupeKey: 'app1:2026-07-22' },
      { $set: { sentAt: expect.any(Date), resendId: 're-1' } },
      { session: mockDbSession },
    ])
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('an existing ledger row (stamped OR unstamped) skips — the key is burned', async () => {
    const beforeDelivery = vi.fn().mockResolvedValue(true)
    mockSendFindOne.mockReturnValue(lean({ dedupeKey: 'app1:2026-07-22' }))
    expect(await sendTransactional({ ...input, beforeDelivery })).toEqual({ outcome: 'already-sent' })
    expect(beforeDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('suppression re-checked immediately before send (R24): e2 or all blocks', async () => {
    const beforeDelivery = vi.fn().mockResolvedValue(true)
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['all'] } } }))
    expect(await sendTransactional({ ...input, beforeDelivery })).toEqual({ outcome: 'suppressed' })
    expect(beforeDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('a changed delivery precondition skips without burning the transactional key', async () => {
    const beforeDelivery = vi.fn().mockResolvedValue(false)

    expect(await sendTransactional({ ...input, beforeDelivery })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(beforeDelivery).toHaveBeenCalledOnce()
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()

    // A policy cancellation is not a burned key; a later authorized
    // derivation can still deliver within the provider's 24-hour window.
    expect(await sendTransactional({
      ...input,
      beforeDelivery: vi.fn().mockResolvedValue(true),
    })).toEqual({ outcome: 'sent', resendId: 're-1' })
  })

  it('blocks an unsubscribe or recipient change that lands during the delivery callback', async () => {
    mockUserFindById
      .mockReturnValueOnce(selectLean({
        email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } },
      }))
      .mockReturnValueOnce(selectLean({
        email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['e2'] } },
      }))

    expect(await sendTransactional({
      ...input,
      beforeDelivery: vi.fn().mockResolvedValue(true),
    })).toEqual({ outcome: 'suppressed' })
    expect(mockSendEmail).not.toHaveBeenCalled()

    mockUserFindById
      .mockReturnValueOnce(selectLean({
        email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } },
      }))
      .mockReturnValueOnce(selectLean({
        email: 'new@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } },
      }))

    expect(await sendTransactional({
      ...input,
      dedupeKey: 'app1:recipient-change',
      beforeDelivery: vi.fn().mockResolvedValue(true),
    })).toEqual({ outcome: 'precondition-failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('re-checks authority before every provider retry', async () => {
    const beforeDelivery = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mockSendEmail.mockResolvedValue({ ok: false })

    expect(await sendTransactional({ ...input, beforeDelivery })).toEqual({
      outcome: 'delivery-uncertain-alerted',
    })
    expect(beforeDelivery).toHaveBeenCalledTimes(2)
    expect(mockSendEmail).toHaveBeenCalledOnce()
    expect(mockSendCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ userId: 'u1', stream: 'e2', dedupeKey: 'app1:2026-07-22' })],
      { session: mockDbSession },
    )
  })

  it('propagates an unavailable delivery gate so durable transactional work can retry', async () => {
    const gateError = new Error('Mongo unavailable')

    await expect(sendTransactional({
      ...input,
      beforeDelivery: vi.fn().mockRejectedValue(gateError),
    })).rejects.toBe(gateError)
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('burns an alert row when the delivery gate errors after an uncertain provider attempt', async () => {
    const gateError = new Error('Mongo unavailable')
    const beforeDelivery = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(gateError)
    mockSendEmail.mockResolvedValue({ ok: false })

    expect(await sendTransactional({ ...input, beforeDelivery })).toEqual({
      outcome: 'delivery-uncertain-alerted',
    })
    expect(mockSendEmail).toHaveBeenCalledOnce()
    expect(mockSendCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ userId: 'u1', stream: 'e2', dedupeKey: 'app1:2026-07-22' })],
      { session: mockDbSession },
    )
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: gateError }),
      expect.stringContaining('delivery uncertain'),
    )
  })

  it('fails closed before the first provider call when the account is missing or recipient changed', async () => {
    mockUserFindById.mockReturnValueOnce(selectLean(null))
    expect(await sendTransactional(input)).toEqual({ outcome: 'precondition-failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()

    mockUserFindById.mockReturnValueOnce(selectLean({
      email: 'new-address@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } },
    }))
    expect(await sendTransactional(input)).toEqual({ outcome: 'precondition-failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('freezes signed headers across same-run provider retries', async () => {
    mockSendEmail.mockResolvedValue({ ok: false })

    expect(await sendTransactional(input)).toEqual({ outcome: 'failed-alerted' })
    expect(mockSendEmail).toHaveBeenCalledTimes(2)
    expect(mockSendEmail.mock.calls[0][0].headers).toBe(mockSendEmail.mock.calls[1][0].headers)
  })

  it('re-checks suppression before retry and alerts because the first delivery is uncertain', async () => {
    mockUserFindById
      .mockReturnValueOnce(selectLean({
        email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } },
      }))
      .mockReturnValueOnce(selectLean({
        email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['e2'] } },
      }))
    mockSendEmail.mockResolvedValue({ ok: false })

    expect(await sendTransactional(input)).toEqual({ outcome: 'delivery-uncertain-alerted' })
    expect(mockSendEmail).toHaveBeenCalledOnce()
    expect(mockSendCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ stream: 'e2', dedupeKey: 'app1:2026-07-22' })],
      { session: mockDbSession },
    )
  })

  it('double failure writes an UNSTAMPED row (alert-now) and logs at error level', async () => {
    mockSendEmail.mockResolvedValue({ ok: false })
    const r = await sendTransactional(input)
    expect(r).toEqual({ outcome: 'failed-alerted' })
    expect(mockSendEmail).toHaveBeenCalledTimes(2)
    const row = mockSendCreate.mock.calls[0][0][0]
    expect(row.sentAt).toBeUndefined()
    expect(row.resendId).toBeUndefined()
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('does not call the provider when the durable account is already deleting', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)

    expect(await sendTransactional(input)).toEqual({ outcome: 'precondition-failed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendFindOne).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('does not recreate a ledger row when deletion wins after provider delivery', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(
      new MockJobsAccountInactiveError('account deleting'),
    )

    expect(await sendTransactional(input)).toEqual({ outcome: 'sent', resendId: 're-1' })
    expect(mockSendEmail).toHaveBeenCalledOnce()
    expect(mockSendUpdateOne).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('isSuppressed: stream, all, and the empty default', () => {
    expect(isSuppressed(['e2'], 'e2')).toBe(true)
    expect(isSuppressed(['all'], 'e0')).toBe(true)
    expect(isSuppressed([], 'e2')).toBe(false)
    expect(isSuppressed(undefined, 'e2')).toBe(false)
  })
})

// ── E0 handler ───────────────────────────────────────────────────────────────

describe('runE0Handler', () => {
  const evt = (requestedAt: string) => ({ data: { userId: 'u1', jobPostingId: 'j1', requestedAt } })

  beforeEach(() => {
    mockAppFindOne.mockReturnValue(selectLean({ _id: 'app1' }))
  })

  it('stream switch OFF → nothing, ever', async () => {
    mockGetConfig.mockResolvedValue({ e0Enabled: false })
    expect(await runE0Handler(evt(new Date().toISOString()), step)).toEqual({ outcome: 'stream-disabled' })
  })

  it('a replayed request older than 24h is DROPPED — past the idempotency window (Codex #530)', async () => {
    const stale = new Date(Date.now() - 25 * 3600_000).toISOString()
    expect(await runE0Handler(evt(stale), step)).toEqual({ outcome: 'past-window' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('happy path: sends with the hour-bucketed dedupeKey', async () => {
    const requestedAt = new Date().toISOString()
    const r = await runE0Handler(evt(requestedAt), { ...step, sleepUntil: undefined })
    expect(r.outcome).toBe('sent')
    expect(mockSendUpdateOne.mock.calls[0][0].dedupeKey).toBe(`app1:${requestedAt.slice(0, 13)}`)
  })

  it('suppressed user (e0 or all) → visible refusal, no send', async () => {
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['e0'] } } }))
    const r = await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })
    expect(r.outcome).toBe('suppressed')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('drops a deferred Practice promise when the posting becomes restricted before send', async () => {
    mockPostingFindById.mockReturnValue(selectLean(posting({
      status: 'closed', closedReason: 'source-revoked',
    })))

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'posting-restricted',
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels already-rendered E0 content when source revocation wins at provider delivery', async () => {
    mockPostingFindById
      .mockReturnValueOnce(selectLean(posting()))
      .mockReturnValueOnce(selectLean(posting({
        status: 'closed', closedReason: 'source-revoked',
      })))

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(mockPreparePractice).toHaveBeenCalledOnce()
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('cancels E0 when its exact JD changes after rendering', async () => {
    mockPreparePractice
      .mockResolvedValueOnce({ jobDescription: 'JD v1', jdHash: 'hash-v1', role: 'backend' })
      .mockResolvedValueOnce({ jobDescription: 'JD v2', jdHash: 'hash-v2', role: 'backend' })

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels E0 when the posting changes during asynchronous Practice preparation', async () => {
    mockPostingExists.mockResolvedValue(null)

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockPostingExists).toHaveBeenCalledWith({
      _id: 'j1',
      status: 'open',
      closedReason: null,
      domain: null,
      parsedJDHash: null,
      parsedJDRoleVersion: null,
      updatedAt: POSTING_UPDATED_AT,
    })
    expect(mockPreparePractice.mock.invocationCallOrder[1]).toBeLessThan(
      mockPostingExists.mock.invocationCallOrder[0],
    )
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels E0 when ownership disappears during asynchronous Practice preparation', async () => {
    mockAppExists
      .mockResolvedValueOnce({ _id: 'app1' })
      .mockResolvedValueOnce(null)

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockAppExists).toHaveBeenCalledTimes(2)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels E0 when the owning tracker relationship disappears before delivery', async () => {
    mockAppExists.mockResolvedValue(null)

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'precondition-failed',
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('honors a deferred Practice promise for an owned, normally archived posting', async () => {
    mockPostingFindById.mockReturnValue(selectLean(posting({
      status: 'closed', closedReason: 'aged-out',
    })))

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'sent',
    })
    expect(mockSendEmail).toHaveBeenCalledOnce()
  })

  it('drops E0 when the retained JD or active CMS role is no longer Practice-ready', async () => {
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash' })

    expect(await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })).toEqual({
      outcome: 'practice-unavailable',
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})

// ── E2 sweep ─────────────────────────────────────────────────────────────────

describe('runEmailSweepHandler', () => {
  const NOW_IN_WINDOW = new Date('2026-07-21T04:00:00Z') // 09:30 IST Tuesday
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_IN_WINDOW)
  })
  afterEach(() => vi.useRealTimers())

  const appRow = (over: Record<string, unknown> = {}) => ({
    _id: 'app1', userId: 'u1', jobPostingId: 'j1',
    interviewDate: new Date('2026-07-22T00:00:00Z'), // IST Jul 22 — T-1 is today
    interviewDateConfidence: 'exact', verifiedPracticeSessionIds: [],
    jobSnapshot: { title: 'Saved Backend Engineer', company: 'Saved Acme' },
    ...over,
  })
  // Cursor-paginated chain: find().select().sort().limit().lean(); rows are
  // consumed page-by-page (Codex #532 pagination).
  const findChain = (rows: unknown[]) => {
    let served = false
    return () => ({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: () => {
              if (served) return Promise.resolve([])
              served = true
              return Promise.resolve(rows)
            },
          }),
        }),
      }),
    })
  }

  it('switch OFF and quiet hours both skip the whole sweep', async () => {
    mockGetConfig.mockResolvedValue({ e2Enabled: false })
    expect(await runEmailSweepHandler(step)).toEqual({ skipped: 'all-streams-disabled' })
    mockGetConfig.mockResolvedValue({ e2Enabled: true })
    vi.setSystemTime(new Date('2026-07-21T17:00:00Z')) // 22:30 IST
    expect(await runEmailSweepHandler(step)).toEqual({ skipped: 'quiet-hours' })
  })

  it('sends a due exact-date T-1 reminder with the date-bound dedupeKey', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e2Sent: 1 })
    expect(mockSendUpdateOne.mock.calls[0][0].dedupeKey).toBe('app1:v2:2026-07-22')
  })

  it('honors a legacy UTC ledger key when the same exact date has a different IST day', async () => {
    // 19:00 UTC is 00:30 IST the next day. Pre-A07 burned Jul 21; the
    // corrected date identity is Jul 22 and must not create a second send.
    mockAppFind.mockImplementation(findChain([appRow({
      interviewDate: new Date('2026-07-21T19:00:00.000Z'),
    })]))
    mockSendFindOne.mockImplementation((query: { dedupeKey?: unknown }) => (
      lean(query.dedupeKey === 'app1:2026-07-21'
        ? { dedupeKey: query.dedupeKey, sentAt: new Date() }
        : null)
    ))

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendFindOne).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      stream: 'e2',
      dedupeKey: 'app1:2026-07-21',
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendUpdateOne).not.toHaveBeenCalled()
  })

  it("candidate query is scoped to status 'interview_scheduled' — a corrected row's stale date never reminds (Codex #532)", async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    await runEmailSweepHandler(step)
    expect(mockAppFind.mock.calls[0][0].status).toBe('interview_scheduled')
    expect(mockAppFind.mock.calls[0][0].interviewDateConfidence).toBe('exact')
  })

  it('labels a within-window interview-day recovery as today, never tomorrow', async () => {
    vi.setSystemTime(new Date('2026-07-21T02:45:00.000Z')) // 08:15 IST, <24h after T-1 send instant
    mockAppFind.mockImplementation(findChain([appRow({
      interviewDate: new Date('2026-07-21T00:00:00.000Z'),
    })]))

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 1 })
    const email = mockSendEmail.mock.calls[0][0] as { subject: string; html: string }
    expect(email.subject).toContain('interview is today')
    expect(email.html).not.toContain('Tomorrow-you')
    expect(mockSendUpdateOne.mock.calls[0][0].dedupeKey).toBe('app1:v2:2026-07-21')
  })

  it('not-yet-due candidates are filtered (send instant in the future)', async () => {
    mockAppFind.mockImplementation(findChain([appRow({ interviewDate: new Date('2026-07-25T00:00:00Z') })]))
    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('per-application ceiling: 3 prior reminders → no more, ever (R19)', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockSendCount.mockResolvedValue(3)
    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('paginates candidates by _id cursor to exhaustion — the tail is never starved behind a head page (Codex #532)', async () => {
    // A full page (200) followed by a short page: both must be visited.
    const page1 = Array.from({ length: 200 }, (_, k) => appRow({ _id: `bulk${k}`, userId: `u${k}` }))
    const page2 = [appRow({ _id: 'tail1', userId: 'uTail' })]
    let call = 0
    mockAppFind.mockImplementation(() => ({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(call++ === 0 ? page1 : call === 2 ? page2 : []) }) }) }),
    }))
    const r = await runEmailSweepHandler(step)
    expect(mockAppFind.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The second page's filter carries the cursor.
    expect(mockAppFind.mock.calls[1][0]._id).toEqual({ $gt: 'bulk199' })
    expect((r as { e2Sent: number }).e2Sent).toBe(201)
  })

  it('past the 24h send window: a recorded reminder is silent, a MISSING ledger row alerts and never auto-sends (Codex #532)', async () => {
    // Interview today (Jul 21 IST): T-1 instant was Jul 20 03:30Z — 24.5h ago.
    // The retained 19:00Z clock also proves the rollout lookup accepts the
    // pre-A07 UTC key (Jul 20) alongside the v2 IST key (Jul 21).
    const stale = appRow({ interviewDate: new Date('2026-07-20T19:00:00Z') })
    mockAppFind.mockImplementation(findChain([stale]))
    // Ledger row present → common case: sent yesterday, nothing to do.
    mockSendFindOne.mockReturnValue(lean({ dedupeKey: 'app1:2026-07-20', sentAt: new Date() }))
    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(mockSendFindOne).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: { $in: ['app1:v2:2026-07-21', 'app1:2026-07-20'] },
    }))

    // Ledger row MISSING → crash-recovery case: alert, refuse to send.
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e2Enabled: true })
    mockSendFindOne.mockReturnValue(lean(null))
    mockAppFind.mockImplementation(findChain([stale]))
    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app1' }),
      expect.stringContaining('human review required')
    )
  })

  it('a practice session in the last 24h switches to the logistics-only variant (R10)', async () => {
    mockAppFind.mockImplementation(findChain([appRow({ verifiedPracticeSessionIds: ['s1'] })]))
    mockSessionExists.mockResolvedValue({ _id: 's1' })
    await runEmailSweepHandler(step)
    const html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).not.toContain('practice=1') // no warm-up CTA
    expect(html).toContain('prep=1')
    expect(mockSessionExists).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      completedAt: { $gte: expect.any(Date), $lte: NOW_IN_WINDOW },
    }))
  })

  it('does not call a future completedAt recent practice', async () => {
    mockAppFind.mockImplementation(findChain([appRow({ verifiedPracticeSessionIds: ['s1'] })]))
    const futureCompletedAt = new Date(NOW_IN_WINDOW.getTime() + 3600_000)
    mockSessionExists.mockImplementation((query: { completedAt?: { $lte?: Date } }) => (
      Promise.resolve(!query.completedAt?.$lte || futureCompletedAt <= query.completedAt.$lte
        ? { _id: 's1' }
        : null)
    ))

    await runEmailSweepHandler(step)

    const html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).toContain('practice=1')
    expect(html).not.toContain('You practiced recently')
  })

  it('keeps E2 transactional but removes exact-job CTAs for restricted or no-longer-ready context', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockPostingFindById.mockReturnValue(selectLean(posting({
      title: 'Untrusted title', company: 'Untrusted company', status: 'closed', closedReason: 'source-revoked',
    })))

    await runEmailSweepHandler(step)

    let html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).toContain('/interview/setup')
    expect(html).not.toContain('practice=1')
    expect(html).not.toContain('Untrusted company')
    expect(html).toContain('Saved Acme')
    expect(mockPreparePractice).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e2Enabled: true, globalWeeklyCap: 3 })
    mockSendFindOne.mockReturnValue(lean(null))
    mockSendCreate.mockResolvedValue({})
    mockSendCount.mockResolvedValue(0)
    mockSendEmail.mockResolvedValue({ ok: true, id: 're-2' })
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } } }))
    mockPostingFindById.mockReturnValue(selectLean(posting()))
    mockPostingExists.mockResolvedValue({ _id: 'j1' })
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash' })
    mockSessionExists.mockResolvedValue(null)
    mockAppFind.mockImplementation(findChain([appRow()]))

    await runEmailSweepHandler(step)
    html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).toContain('/interview/setup')
    expect(html).not.toContain('practice=1')
  })

  it('cancels an already-rendered canonical E2 when source revocation wins at delivery', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockPostingFindById
      .mockReturnValueOnce(selectLean(posting()))
      .mockReturnValueOnce(selectLean(posting({
        status: 'closed', closedReason: 'source-revoked',
      })))

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })

  it('cancels E2 when the posting changes during asynchronous Practice preparation', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockPostingExists.mockResolvedValue(null)

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockPostingExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'j1', status: 'open', updatedAt: POSTING_UPDATED_AT,
    }))
    expect(mockPreparePractice.mock.invocationCallOrder[1]).toBeLessThan(
      mockPostingExists.mock.invocationCallOrder[0],
    )
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels E2 when the exact tracker row changes during asynchronous Practice preparation', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockAppExists
      .mockResolvedValueOnce({ _id: 'app1' })
      .mockResolvedValueOnce(null)

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockAppExists).toHaveBeenCalledTimes(2)
    expect(mockAppExists.mock.calls[1][0]).toEqual(expect.objectContaining({
      _id: 'app1',
      userId: 'u1',
      jobPostingId: 'j1',
      status: 'interview_scheduled',
      interviewDate: new Date('2026-07-22T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('cancels E2 when the tracker status or interview date changes after derivation', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockAppExists.mockResolvedValue(null)

    expect(await runEmailSweepHandler(step)).toMatchObject({ e2Sent: 0 })
    expect(mockAppExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'app1',
      status: 'interview_scheduled',
      interviewDate: new Date('2026-07-22T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendCreate).not.toHaveBeenCalled()
  })
})

// ── Solicitation sweep: E1 + E4 (PR-C) ──────────────────────────────────────

describe('runEmailSweepHandler — solicitation E1/E4', () => {
  const NOW = new Date('2026-07-21T04:00:00Z') // 09:30 IST Tuesday
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockGetConfig.mockResolvedValue({ e0Enabled: false, e1Enabled: true, e2Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
    mockPostingFindById.mockReturnValue(selectLean(posting()))
  })
  afterEach(() => vi.useRealTimers())

  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
  const e1Row = (id: string, over: Record<string, unknown> = {}) => ({
    _id: id, userId: '507f1f77bcf86cd799439011', jobPostingId: `j-${id}`,
    status: 'applied', updatedAt: new Date('2026-07-21T03:30:00.000Z'),
    appliedAt: daysAgo(15),
    statusHistory: [{ status: 'applied', at: daysAgo(15), source: 'user' }],
    outcome: {}, practiceSessionIds: ['s1'],
    jobSnapshot: { title: 'Backend Engineer', company: `Acme-${id}` },
    ...over,
  })
  const e4Row = (id: string, over: Record<string, unknown> = {}) => ({
    _id: id, userId: '507f1f77bcf86cd799439011', jobPostingId: `j-${id}`,
    status: 'apply_clicked', updatedAt: new Date('2026-07-21T03:30:00.000Z'),
    statusHistory: [{ status: 'apply_clicked', at: daysAgo(5), source: 'system' }],
    outcome: {}, practiceSessionIds: [],
    jobSnapshot: { title: 'Backend Engineer', company: `Acme-${id}` },
    ...over,
  })
  // Two paginate calls (E1 then E4), each cursor-terminated by a short page.
  const feed = (e1Rows: unknown[], e4Rows: unknown[]) => {
    let call = 0
    mockAppFind.mockImplementation(() => ({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(call++ === 0 ? e1Rows : e4Rows) }) }) }),
    }))
  }

  it('E1: one due application → one email with three one-tap action URLs; the shared ask budget is consumed', async () => {
    feed([e1Row('a1')], [])
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e1Sent: 1, e4Sent: 0 })
    const html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).toContain('/api/jobs/email-action?token=')
    // Reserve-first: the ledger row was created BEFORE the send.
    expect(mockSendCreate.mock.invocationCallOrder[0]).toBeLessThan(mockSendEmail.mock.invocationCallOrder[0])
    // Shared response-ask ledger consumed (R4).
    expect(mockAppUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['a1'] } },
      { $set: { 'outcome.lastAskedAt': expect.any(Date) }, $inc: { 'outcome.askCount': 1 } }
    )
  })

  it('E1 batching: three due applications collapse into ONE email consuming ONE cap slot (R2)', async () => {
    feed([e1Row('a1'), e1Row('a2'), e1Row('a3')], [])
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e1Sent: 1 })
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('3 applications')
  })

  it('E1 defers when the in-app nudge asked within 7 days (shared ledger, R4)', async () => {
    feed([e1Row('a1', { outcome: { lastAskedAt: daysAgo(2) } })], [])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e1Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('E1 skips rows the user touched within 14 days', async () => {
    feed([e1Row('a1', { statusHistory: [{ status: 'applied', at: daysAgo(15), source: 'user' }, { status: 'ghosted', at: daysAgo(2), source: 'user' }] })], [])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e1Sent: 0 })
  })

  it('weekly cap: 3 solicitation sends in the last 7d → everything drops, never queues', async () => {
    mockSendAggregate.mockResolvedValue([{ n: 3 }]) // solicitationSentLast7d: 3 distinct EMAILS
    feed([e1Row('a1')], [e4Row('b1')])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e1Sent: 0, e4Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('priority: with one cap slot left, E1 sends and E4 drops', async () => {
    mockSendAggregate.mockResolvedValue([{ n: 2 }]) // 2 emails this week → remaining 1
    feed([e1Row('a1')], [e4Row('b1')])
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e1Sent: 1, e4Sent: 0 })
  })

  it('E4: honored E0 consumes it; closed posting skips it', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    // honored E0: the e0-prefix ledger lookup returns a stamped row
    mockSendFindOne.mockImplementation((q: { stream?: string }) =>
      lean(q.stream === 'e0' ? { sentAt: new Date() } : null))
    feed([e4Row('b1')], []) // e1 disabled → E4's paginate is the FIRST find call
    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()

    // closed posting
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
    mockSendFindOne.mockReturnValue(lean(null))
    mockSendCount.mockResolvedValue(0)
    mockSendUpdateMany.mockResolvedValue({})
    mockSendCreate.mockResolvedValue({})
    mockPostingFindById.mockReturnValue(selectLean({ status: 'closed' }))
    feed([e4Row('b1')], [])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockPreparePractice).not.toHaveBeenCalled()
  })

  it('E4 revalidates exact-posting Practice readiness at send time and does not burn an unready candidate', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash' }) // CMS role was deactivated after derivation
    feed([e4Row('b1')], [])

    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockPreparePractice).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }))
    expect(mockSendCreate).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('E4 releases its reservation when exact-posting Practice becomes unavailable immediately before delivery', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockPreparePractice
      .mockResolvedValueOnce({ jobDescription: 'JD', jdHash: 'hash', role: 'backend' })
      .mockResolvedValueOnce({ jobDescription: 'JD', jdHash: 'hash' })
    feed([e4Row('b1')], [])

    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockSendCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        userId: '507f1f77bcf86cd799439011',
        stream: 'e4',
        dedupeKey: 'b1',
      })],
      { session: mockDbSession },
    )
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockSendDeleteMany).toHaveBeenCalledWith({
      userId: '507f1f77bcf86cd799439011',
      stream: 'e4',
      dedupeKey: { $in: ['b1'] },
      sentAt: { $exists: false },
    })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('E4 fails closed and releases its reservation when the final readiness lookup errors', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockPreparePractice
      .mockResolvedValueOnce({ jobDescription: 'JD', jdHash: 'hash', role: 'backend' })
      .mockRejectedValueOnce(new Error('CMS unavailable'))
    feed([e4Row('b1')], [])

    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockSendDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
      stream: 'e4',
      dedupeKey: { $in: ['b1'] },
      sentAt: { $exists: false },
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('E4 cancels when source authority or tracker eligibility changes during Practice preparation', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockPostingExists.mockResolvedValue(null)
    feed([e4Row('b1')], [])

    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockPreparePractice).toHaveBeenCalledTimes(2)
    expect(mockPostingExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'j-b1', status: 'open', updatedAt: POSTING_UPDATED_AT,
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
    mockPostingFindById.mockReturnValue(selectLean(posting()))
    mockPostingExists.mockResolvedValue({ _id: 'j-b2' })
    mockAppExists.mockResolvedValue(null)
    mockSendFindOne.mockReturnValue(lean(null))
    mockSendCreate.mockResolvedValue({})
    mockSendDeleteMany.mockResolvedValue({})
    mockSendAggregate.mockResolvedValue([])
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash', role: 'backend' })
    feed([e4Row('b2')], [])

    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockAppExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'b2', status: 'apply_clicked', practiceSessionIds: { $size: 0 },
      updatedAt: new Date('2026-07-21T03:30:00.000Z'),
    }))
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('the cap counts EMAILS, not ledger rows: the pipeline groups on resendId (Codex #533)', async () => {
    feed([e1Row('a1')], [])
    await runEmailSweepHandler(step)
    const pipeline = mockSendAggregate.mock.calls[0][0]
    const group = pipeline.find((st: Record<string, unknown>) => st.$group) as { $group: { _id: unknown } }
    expect(group.$group._id).toEqual({ $ifNull: ['$resendId', '$sentAt'] })
  })

  it('an in-window unsubscribe between reservation and send releases the reservation and blocks delivery (Codex #533)', async () => {
    feed([e1Row('a1')], [])
    // Sweep pre-check sees a clean user; the send-time re-check sees the
    // one-click unsubscribe that landed in between.
    mockUserFindById
      .mockReturnValueOnce(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
      .mockReturnValueOnce(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: ['e1'] } } }))
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e1Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ stream: 'e1', sentAt: { $exists: false } })
    )
  })

  it("E4 copy never claims 'applied' for an apply_clicked row (Codex #533 — machine-fact honesty in the inbox)", async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    feed([e4Row('b1')], []) // e1 disabled → E4 paginates first; intent is apply_clicked
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e4Sent: 1 })
    const { subject, html } = mockSendEmail.mock.calls[0][0] as { subject: string; html: string }
    expect(subject).not.toMatch(/your .* application/i)
    expect(html).not.toContain('You applied')
    expect(html).toContain('You opened the apply page')
    expect(html).toContain('you clicked apply on')
  })

  it('a nudges toggle flipped mid-window releases the reservation before delivery (Codex #533)', async () => {
    feed([e1Row('a1')], [])
    mockUserFindById
      .mockReturnValueOnce(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
      .mockReturnValueOnce(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: false, unsubscribedStreams: [] } } }))
    const r = await runEmailSweepHandler(step)
    expect(r).toMatchObject({ e1Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockSendDeleteMany).toHaveBeenCalled()
  })

  it('clicked-then-confirmed rows key off the LATEST entry: fresh confirmations wait, aged ones get applied copy (Codex #533)', async () => {
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    // Clicked 5d ago but CONFIRMED yesterday → age anchors on the
    // confirmation (1d) → not yet due.
    feed([e4Row('b1', {
      status: 'applied',
      statusHistory: [
        { status: 'apply_clicked', at: daysAgo(5), source: 'system' },
        { status: 'applied', at: daysAgo(1), source: 'user' },
      ],
    })], [])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()

    // Clicked 8d ago, confirmed 4d ago → due, with APPLIED copy.
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e1Enabled: false, e4Enabled: true, globalWeeklyCap: 3 })
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } } }))
    mockPostingFindById.mockReturnValue(selectLean(posting()))
    mockSendFindOne.mockReturnValue(lean(null))
    mockSendCreate.mockResolvedValue({})
    mockSendUpdateMany.mockResolvedValue({})
    mockSendAggregate.mockResolvedValue([])
    mockSendEmail.mockResolvedValue({ ok: true, id: 're-1' })
    feed([e4Row('b2', {
      status: 'applied',
      statusHistory: [
        { status: 'apply_clicked', at: daysAgo(8), source: 'system' },
        { status: 'applied', at: daysAgo(4), source: 'user' },
      ],
    })], [])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e4Sent: 1 })
    const html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).toContain('You applied')
    expect(html).not.toContain('You opened the apply page')
  })

  it('coarse nudges=false silences both solicitation streams', async () => {
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { nudges: false, unsubscribedStreams: [] } } }))
    feed([e1Row('a1')], [e4Row('b1')])
    expect(await runEmailSweepHandler(step)).toMatchObject({ e1Sent: 0, e4Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})
