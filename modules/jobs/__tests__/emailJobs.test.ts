import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * PR-B — transactional email streams E0 + E2 (EMAILS.md §1/§2/§6).
 * Covers: IST timing math, template honesty rules, the transactional send
 * discipline (send-first + idempotency key, unstamped-row alerting), the
 * E0 handler gates, and the E2 sweep derivation matrix.
 */

const {
  mockGetConfig, mockSendEmail, mockSendFindOne, mockSendCreate, mockSendCount,
  mockUserFindById, mockAppFindOne, mockAppFind, mockAppExists, mockPostingFindById,
  mockSessionExists, mockInngestSend, mockLoggerError,
} = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockSendEmail: vi.fn(),
  mockSendFindOne: vi.fn(),
  mockSendCreate: vi.fn(),
  mockSendCount: vi.fn(),
  mockUserFindById: vi.fn(),
  mockAppFindOne: vi.fn(),
  mockAppFind: vi.fn(),
  mockAppExists: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockSessionExists: vi.fn(),
  mockInngestSend: vi.fn(),
  mockLoggerError: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError } }))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: mockInngestSend, createFunction: vi.fn(() => ({})) },
}))
vi.mock('@shared/services/emailService', () => ({ sendEmail: mockSendEmail }))
vi.mock('@shared/services/signedActionToken', () => ({
  mintActionToken: vi.fn((input: { action: string }) => `tok-${input.action}`),
}))
vi.mock('@shared/db/models', () => ({
  JobsEmailConfig: { getConfig: mockGetConfig },
  JobsEmailSend: { findOne: mockSendFindOne, create: mockSendCreate, countDocuments: mockSendCount },
  User: { findById: mockUserFindById },
  JobApplication: { findOne: mockAppFindOne, find: mockAppFind, exists: mockAppExists },
  JobPosting: { findById: mockPostingFindById },
  InterviewSession: { exists: mockSessionExists },
  ProductEvent: { create: vi.fn().mockResolvedValue({}) },
}))

import { isInSendWindow, nextSendSlot, e2SendInstant, istCalendarDaysBetween } from '../config/emailTiming'
import { BANNED_SUBJECT_PATTERNS } from '../emails/shared'
import { buildE0Email } from '../emails/e0'
import { buildE2Email } from '../emails/e2'
import { sendTransactional, isSuppressed } from '../services/emailSendService'
import { runE0Handler, runEmailSweepHandler } from '../jobs/emailJobs'

const step = {
  run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
  sleepUntil: vi.fn().mockResolvedValue(undefined),
}
const lean = (v: unknown) => ({ lean: () => Promise.resolve(v), select: function () { return this } })
const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetConfig.mockResolvedValue({ e0Enabled: true, e2Enabled: true, globalWeeklyCap: 3 })
  mockSendFindOne.mockReturnValue(lean(null))
  mockSendCreate.mockResolvedValue({})
  mockSendCount.mockResolvedValue(0)
  mockSendEmail.mockResolvedValue({ ok: true, id: 're-1' })
  mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: [] } } }))
  mockPostingFindById.mockReturnValue(selectLean({ title: 'Backend Engineer', company: 'Acme' }))
  mockSessionExists.mockResolvedValue(null)
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
    expect(e2SendInstant(interview, 'exact', now)!.toISOString()).toBe('2026-07-21T03:30:00.000Z') // Jul 21 09:00 IST
    // Past the interview day's end → null
    expect(e2SendInstant(interview, 'exact', new Date('2026-07-23T00:00:00Z'))).toBeNull()
  })

  it('e2SendInstant week: Monday 09:00 IST; late-armed → STABLE most-recent 09:00 (Codex #532); week over → never', () => {
    const interview = new Date('2026-07-23T00:00:00Z') // Thursday IST
    // Armed the prior week → Monday Jul 20 09:00 IST (03:30 UTC)
    expect(e2SendInstant(interview, 'week', new Date('2026-07-18T00:00:00Z'))!.toISOString()).toBe('2026-07-20T03:30:00.000Z')
    // Monday passed, derived Wednesday 14:00 IST → most recent 09:00 =
    // Wednesday 03:30Z — ALREADY DUE, so the next in-window sweep sends.
    expect(e2SendInstant(interview, 'week', new Date('2026-07-22T08:30:00Z'))!.toISOString()).toBe('2026-07-22T03:30:00.000Z')
    // Tuesday 03:00 IST (hour<9) → most recent 09:00 = Monday 03:30Z.
    expect(e2SendInstant(interview, 'week', new Date('2026-07-20T21:30:00Z'))!.toISOString()).toBe('2026-07-20T03:30:00.000Z')
    // Week has passed → null
    expect(e2SendInstant(interview, 'week', new Date('2026-07-27T00:00:00Z'))).toBeNull()
  })

  it('the week due instant does NOT move between hourly sweeps — reminders actually fire (Codex #532)', () => {
    const interview = new Date('2026-07-23T00:00:00Z') // Thursday IST
    const sweep1 = e2SendInstant(interview, 'week', new Date('2026-07-21T04:05:00Z'))! // Tue 09:35 IST
    const sweep2 = e2SendInstant(interview, 'week', new Date('2026-07-21T05:05:00Z'))! // Tue 10:35 IST
    expect(sweep1.toISOString()).toBe(sweep2.toISOString())
    expect(sweep1.getTime()).toBeLessThanOrEqual(new Date('2026-07-21T04:05:00Z').getTime())
  })

  it('istCalendarDaysBetween counts IST calendar days', () => {
    // 23:30 IST → 00:30 IST next day = 1 calendar day apart
    expect(istCalendarDaysBetween(new Date('2026-07-20T18:00:00Z'), new Date('2026-07-20T19:00:00Z'))).toBe(1)
  })
})

// ── Templates (honesty rules) ────────────────────────────────────────────────

describe('templates', () => {
  const footer = { whyLine: 'you asked for this', unsubscribeStreamUrl: 'https://x/u?s', unsubscribeAllUrl: 'https://x/u?a' }

  it('subjects never impersonate employer contact (banned-pattern list, R9)', () => {
    const subjects = [
      buildE0Email({ company: 'Acme', jobTitle: 'Backend Engineer', practiceUrl: 'https://x/p', footer }).subject,
      buildE2Email({ company: 'Acme', jobTitle: 'Backend Engineer', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/w', logisticsOnly: false, footer }).subject,
      buildE2Email({ company: 'Acme', jobTitle: 'Backend Engineer', whenLabel: 'this week', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/w', logisticsOnly: true, footer }).subject,
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
    const full = buildE2Email({ company: 'Acme', jobTitle: 'X', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/warm', logisticsOnly: false, footer })
    const light = buildE2Email({ company: 'Acme', jobTitle: 'X', whenLabel: 'tomorrow', prepPlanUrl: 'https://x/pp', warmUpUrl: 'https://x/warm', logisticsOnly: true, footer })
    expect(full.html).toContain('https://x/warm')
    expect(light.html).not.toContain('https://x/warm')
  })

  it('templates escape user-influenced strings', () => {
    const { html } = buildE0Email({ company: '<script>alert(1)</script>', jobTitle: 'X', practiceUrl: 'https://x/p', footer })
    expect(html).not.toContain('<script>')
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
    expect(mockSendCreate).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'app1:2026-07-22', resendId: 're-1' }))
  })

  it('an existing ledger row (stamped OR unstamped) skips — the key is burned', async () => {
    mockSendFindOne.mockReturnValue(lean({ dedupeKey: 'app1:2026-07-22' }))
    expect(await sendTransactional(input)).toEqual({ outcome: 'already-sent' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('suppression re-checked immediately before send (R24): e2 or all blocks', async () => {
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['all'] } } }))
    expect(await sendTransactional(input)).toEqual({ outcome: 'suppressed' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('double failure writes an UNSTAMPED row (alert-now) and logs at error level', async () => {
    mockSendEmail.mockResolvedValue({ ok: false })
    const r = await sendTransactional(input)
    expect(r).toEqual({ outcome: 'failed-alerted' })
    expect(mockSendEmail).toHaveBeenCalledTimes(2)
    const row = mockSendCreate.mock.calls[0][0]
    expect(row.sentAt).toBeUndefined()
    expect(row.resendId).toBeUndefined()
    expect(mockLoggerError).toHaveBeenCalled()
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
    const requestedAt = '2026-07-20T05:15:00.000Z' // 10:45 IST — in window
    const r = await runE0Handler(evt(requestedAt), { ...step, sleepUntil: undefined })
    expect(r.outcome).toBe('sent')
    expect(mockSendCreate.mock.calls[0][0].dedupeKey).toBe('app1:2026-07-20T05')
  })

  it('suppressed user (e0 or all) → visible refusal, no send', async () => {
    mockUserFindById.mockReturnValue(selectLean({ email: 'u@x.com', emailPreferences: { jobs: { unsubscribedStreams: ['e0'] } } }))
    const r = await runE0Handler(evt(new Date().toISOString()), { ...step, sleepUntil: undefined })
    expect(r.outcome).toBe('suppressed')
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
    interviewDateConfidence: 'exact', practiceSessionIds: [],
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
    expect(await runEmailSweepHandler(step)).toEqual({ skipped: 'e2-disabled' })
    mockGetConfig.mockResolvedValue({ e2Enabled: true })
    vi.setSystemTime(new Date('2026-07-21T17:00:00Z')) // 22:30 IST
    expect(await runEmailSweepHandler(step)).toEqual({ skipped: 'quiet-hours' })
  })

  it('sends a due exact-date T-1 reminder with the date-bound dedupeKey', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    const r = await runEmailSweepHandler(step)
    expect(r).toEqual({ e2Sent: 1 })
    expect(mockSendCreate.mock.calls[0][0].dedupeKey).toBe('app1:2026-07-22')
  })

  it("candidate query is scoped to status 'interview_scheduled' — a corrected row's stale date never reminds (Codex #532)", async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    await runEmailSweepHandler(step)
    expect(mockAppFind.mock.calls[0][0].status).toBe('interview_scheduled')
  })

  it('not-yet-due candidates are filtered (send instant in the future)', async () => {
    mockAppFind.mockImplementation(findChain([appRow({ interviewDate: new Date('2026-07-25T00:00:00Z') })]))
    expect(await runEmailSweepHandler(step)).toEqual({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('per-application ceiling: 3 prior reminders → no more, ever (R19)', async () => {
    mockAppFind.mockImplementation(findChain([appRow()]))
    mockSendCount.mockResolvedValue(3)
    expect(await runEmailSweepHandler(step)).toEqual({ e2Sent: 0 })
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
    const stale = appRow({ interviewDate: new Date('2026-07-21T00:00:00Z') })
    mockAppFind.mockImplementation(findChain([stale]))
    // Ledger row present → common case: sent yesterday, nothing to do.
    mockSendFindOne.mockReturnValue(lean({ dedupeKey: 'app1:2026-07-21', sentAt: new Date() }))
    expect(await runEmailSweepHandler(step)).toEqual({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLoggerError).not.toHaveBeenCalled()

    // Ledger row MISSING → crash-recovery case: alert, refuse to send.
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ e2Enabled: true })
    mockSendFindOne.mockReturnValue(lean(null))
    mockAppFind.mockImplementation(findChain([stale]))
    expect(await runEmailSweepHandler(step)).toEqual({ e2Sent: 0 })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app1' }),
      expect.stringContaining('human review required')
    )
  })

  it('a practice session in the last 24h switches to the logistics-only variant (R10)', async () => {
    mockAppFind.mockImplementation(findChain([appRow({ practiceSessionIds: ['s1'] })]))
    mockSessionExists.mockResolvedValue({ _id: 's1' })
    await runEmailSweepHandler(step)
    const html = mockSendEmail.mock.calls[0][0].html as string
    expect(html).not.toContain('practice=1') // no warm-up CTA
    expect(html).toContain('prep=1')
  })
})
