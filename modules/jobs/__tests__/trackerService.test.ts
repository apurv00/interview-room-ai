import { describe, it, expect, vi } from 'vitest'

const {
  mockFind,
  mockPostingFind,
  mockBulkWrite,
  mockUpdateOne,
  mockRecordJobsUserEvent,
  mockIsJobsAccountActive,
  mockWithActiveJobsAccountWrite,
} = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockPostingFind: vi.fn(),
  mockBulkWrite: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobApplication: { find: mockFind, bulkWrite: mockBulkWrite, updateOne: mockUpdateOne },
  JobPosting: { find: mockPostingFind },
}))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
      this.name = 'JobsAccountInactiveError'
    }
  },
  isJobsAccountActive: mockIsJobsAccountActive,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { getTracker, dismissConfirmCard, saveNotes } from '../services/trackerService'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const NOW = new Date('2026-07-14T12:00:00Z')
const TRANSACTION_SESSION = { id: 'jobs-account-fence-session' }

function daysAgo(d: number, hours = 0): Date {
  return new Date(NOW.getTime() - d * 24 * 3600_000 - hours * 3600_000)
}

let idCounter = 0
function app(over: Record<string, unknown> = {}) {
  idCounter++
  return {
    _id: `a${idCounter}`,
    jobPostingId: `j${idCounter}`,
    jobSnapshot: { title: 'SDE', company: 'PhonePe', location: 'Pune' },
    status: 'applied',
    statusHistory: [{ status: 'applied', at: daysAgo(1), source: 'user' }],
    appliedAt: daysAgo(1),
    practiceSessionIds: [],
    verifiedPracticeSessionIds: [],
    outcome: { askCount: 0 },
    updatedAt: daysAgo(1),
    ...over,
  }
}

function chain(apps: unknown[]) {
  // main tracker query: select→sort→limit→lean; the contested-race refetch
  // uses select→lean and is mocked per-test with mockReturnValueOnce.
  mockFind.mockReturnValue({
    select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(apps) }) }) }),
  })
  mockPostingFind.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve((apps as Array<{ jobPostingId: string }>).map((row) => ({ _id: row.jobPostingId, status: 'open' }))) }),
  })
}

function reset() {
  for (const m of [mockFind, mockPostingFind, mockBulkWrite, mockUpdateOne, mockRecordJobsUserEvent, mockIsJobsAccountActive, mockWithActiveJobsAccountWrite]) m.mockReset()
  mockBulkWrite.mockImplementation(async (ops: unknown[]) => ({ modifiedCount: (ops as unknown[]).length }))
  mockUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockRecordJobsUserEvent.mockResolvedValue(true)
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: typeof TRANSACTION_SESSION) => Promise<unknown> | unknown) =>
      work(TRANSACTION_SESSION),
  )
}

describe('getTracker (Wave 4.2 — pure read-time derivation)', () => {
  it('groups by status in action-first order with counts', async () => {
    reset()
    chain([
      app({ status: 'saved', statusHistory: [{ status: 'saved', at: daysAgo(1), source: 'user' }] }),
      app({ status: 'interview_scheduled', statusHistory: [{ status: 'interview_scheduled', at: daysAgo(1), source: 'user' }] }),
      app({ status: 'applied' }),
      app({ status: 'applied' }),
    ])
    const v = await getTracker('u1', NOW)
    expect(v.groups.map((g) => [g.status, g.count])).toEqual([
      ['interview_scheduled', 1],
      ['applied', 2],
      ['saved', 1],
    ])
  })

  it('7d → waiting nudge, 21d → ghost prompt; saved/terminal rows never nudge', async () => {
    reset()
    const legacyUnconfirmed = app({
      appliedAt: undefined,
      statusHistory: [{ status: 'applied', at: daysAgo(30), source: 'user' }],
    })
    chain([
      app({ statusHistory: [{ status: 'applied', at: daysAgo(8), source: 'user' }] }),
      app({ statusHistory: [{ status: 'applied', at: daysAgo(22), source: 'user' }] }),
      legacyUnconfirmed,
      app({ status: 'saved', statusHistory: [{ status: 'saved', at: daysAgo(30), source: 'user' }] }),
      app({ status: 'offer', statusHistory: [{ status: 'offer', at: daysAgo(30), source: 'user' }] }),
    ])
    const v = await getTracker('u1', NOW)
    const flat = v.groups.flatMap((g) => g.rows)
    expect(flat.find((r) => r.status === 'applied' && r.daysInStatus === 8)!.nudge).toBe('waiting')
    expect(flat.find((r) => r.status === 'applied' && r.daysInStatus === 22)!.nudge).toBe('ghost-prompt')
    expect(flat.find((r) => r.jobPostingId === legacyUnconfirmed.jobPostingId)!.nudge).toBeNull()
    expect(flat.find((r) => r.status === 'saved')!.nudge).toBeNull()
    expect(flat.find((r) => r.status === 'offer')!.nudge).toBeNull()
  })

  it('repeated GETs stay read-only and never turn an unconfirmed click into No response', async () => {
    reset()
    const staleApplied = app({ statusHistory: [{ status: 'applied', at: daysAgo(36), source: 'user' }] })
    const staleClick = app({
      status: 'apply_clicked',
      statusHistory: [{ status: 'apply_clicked', at: daysAgo(60), source: 'system' }],
    })
    chain([staleApplied, staleClick])

    const first = await getTracker('u1', NOW)
    const second = await getTracker('u1', NOW)
    const rows = first.groups.flatMap((group) => group.rows)

    expect(second).toEqual(first)
    expect(rows.find((row) => row.jobPostingId === staleApplied.jobPostingId)).toMatchObject({
      status: 'applied',
      nudge: 'ghost-prompt',
    })
    expect(rows.find((row) => row.jobPostingId === staleClick.jobPostingId)).toMatchObject({
      status: 'apply_clicked',
      nudge: null,
      unconfirmedClick: true,
    })
    expect(first.groups.find((group) => group.status === 'ghosted')).toBeUndefined()
    expect(mockBulkWrite).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('propagates account unavailability without reading, writing, or emitting', async () => {
    reset()
    mockIsJobsAccountActive.mockResolvedValueOnce(false)

    await expect(getTracker('u1', NOW)).rejects.toBeInstanceOf(JobsAccountInactiveError)
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockBulkWrite).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns no private rows when deletion starts while the read is being assembled', async () => {
    reset()
    chain([app()])
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(getTracker('u1', NOW)).resolves.toEqual({ groups: [], confirmCard: null })
    expect(mockBulkWrite).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('counts only verified practice and quarantines legacy attendance', async () => {
    reset()
    const verified = app({
      practiceSessionIds: ['legacy-a', 'verified-a', 'verified-b', 'verified-c', 'verified-d'],
      verifiedPracticeSessionIds: ['verified-a', 'verified-b', 'verified-c', 'verified-d'],
    })
    const legacyOnly = app({
      practiceSessionIds: ['legacy-a', 'legacy-b', 'legacy-c'],
      verifiedPracticeSessionIds: [],
    })
    chain([verified, legacyOnly])

    const view = await getTracker('u1', NOW)
    const rows = view.groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === verified.jobPostingId)?.practiceCount).toBe(3)
    expect(rows.find((row) => row.jobPostingId === legacyOnly.jobPostingId)?.practiceCount).toBe(0)
  })

  it('projects exact interview dates separately from coarse preferences', async () => {
    reset()
    const preference = app({
      status: 'interview_scheduled',
      interviewDateConfidence: 'week',
      interviewDatePreference: 'next-week',
    })
    const exact = app({
      status: 'interview_scheduled',
      interviewDate: new Date('2026-07-30T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
    })
    chain([preference, exact])

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === preference.jobPostingId)).toMatchObject({
      interviewDate: undefined,
      interviewDateConfidence: 'week',
      interviewDatePreference: 'next-week',
    })
    expect(rows.find((row) => row.jobPostingId === exact.jobPostingId)).toMatchObject({
      interviewDate: '2026-07-30T00:00:00.000Z',
      interviewDateConfidence: 'exact',
    })
  })

  it('offers the next raw-outcome round only after an exact date plus the 36-hour safety grace', async () => {
    reset()
    const due = app({
      status: 'interview_scheduled',
      // Exactly date + 36h is due (NOW is 2026-07-14T12:00Z).
      interviewDate: new Date('2026-07-13T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
      outcome: { askCount: 0, interviewRounds: 1 },
    })
    const insideGrace = app({
      status: 'interview_scheduled',
      interviewDate: new Date('2026-07-13T00:01:00.000Z'),
      interviewDateConfidence: 'exact',
      outcome: { askCount: 0, interviewRounds: 0 },
    })
    const deferred = app({
      status: 'interview_scheduled',
      interviewDate: new Date('2026-07-10T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
      outcome: { askCount: 0, interviewRounds: 2, lastDeferredRound: 3 },
    })
    const clickOnly = app({
      status: 'apply_clicked',
      interviewDate: new Date('2026-07-01T00:00:00.000Z'),
      interviewDateConfidence: 'exact',
      outcome: {
        askCount: 0,
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: new Date('2026-07-10T00:00:00.000Z'),
      },
    })
    chain([due, insideGrace, deferred, clickOnly])

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === due.jobPostingId)).toMatchObject({
      nextOutcomeRound: 2,
      outcomePromptDue: true,
      outcome: { roundsCompleted: 1 },
    })
    expect(rows.find((row) => row.jobPostingId === insideGrace.jobPostingId)).toMatchObject({
      nextOutcomeRound: 1,
      outcomePromptDue: false,
    })
    expect(rows.find((row) => row.jobPostingId === deferred.jobPostingId)).toMatchObject({
      nextOutcomeRound: 3,
      outcomePromptDue: false,
    })
    expect(rows.find((row) => row.jobPostingId === clickOnly.jobPostingId)).toMatchObject({
      outcomePromptDue: false,
      canCorrectOutcome: false,
    })
    expect(rows.find((row) => row.jobPostingId === clickOnly.jobPostingId)?.nextOutcomeRound).toBeUndefined()
  })

  it('projects only a complete canonical latest outcome and preserves candidate-authored history on unavailable postings', async () => {
    reset()
    const canonical = app({
      status: 'interviewed',
      outcome: {
        askCount: 0,
        interviewRounds: 2,
        latestResult: 'waiting',
        latestRound: 2,
        latestReportedAt: new Date('2026-07-13T08:00:00.000Z'),
        revision: 7,
        lastInterviewedAt: new Date('2026-07-13T07:00:00.000Z'),
        privateCalibrationNotes: 'MUST NOT LEAK',
      },
    })
    const incomplete = app({
      status: 'rejected',
      outcome: {
        askCount: 0,
        interviewRounds: 2,
        latestResult: 'rejected',
        latestRound: 1,
        latestReportedAt: new Date('2026-07-12T08:00:00.000Z'),
        revision: 1,
      },
    })
    chain([canonical, incomplete])
    mockPostingFind.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve([]) }),
    })

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)
    const canonicalRow = rows.find((row) => row.jobPostingId === canonical.jobPostingId)
    const incompleteRow = rows.find((row) => row.jobPostingId === incomplete.jobPostingId)

    expect(canonicalRow).toMatchObject({
      status: 'interviewed',
      postingState: 'snapshot-only',
      canCorrectOutcome: true,
      outcome: {
        roundsCompleted: 2,
        latestResult: 'waiting',
        latestRound: 2,
        latestReportedAt: '2026-07-13T08:00:00.000Z',
        revision: 7,
        lastInterviewedAt: '2026-07-13T07:00:00.000Z',
      },
    })
    expect(JSON.stringify(canonicalRow)).not.toContain('MUST NOT LEAK')
    expect(incompleteRow).toMatchObject({
      canCorrectOutcome: false,
      outcome: { roundsCompleted: 2 },
    })
    expect(incompleteRow?.outcome.latestResult).toBeUndefined()
  })

  it('keeps a canonical latest outcome correctable after explicit no-response or withdrawal closure', async () => {
    reset()
    const rowsWithClosure = ['ghosted', 'withdrawn'].map((status) => app({
      status,
      outcome: {
        askCount: 0,
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: new Date('2026-07-13T08:00:00.000Z'),
        revision: 3,
      },
    }))
    chain(rowsWithClosure)

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    for (const application of rowsWithClosure) {
      expect(rows.find((row) => row.jobPostingId === application.jobPostingId)).toMatchObject({
        status: application.status,
        canCorrectOutcome: true,
        outcome: { latestResult: 'waiting', latestRound: 1, revision: 3 },
      })
    }
  })

  it('preserves a canonical outcome as read-only history after the application is reopened', async () => {
    reset()
    const reopened = ['saved', 'applied'].map((status) => app({
      status,
      outcome: {
        askCount: 0,
        interviewRounds: 2,
        latestResult: 'advanced',
        latestRound: 2,
        latestReportedAt: new Date('2026-07-13T08:00:00.000Z'),
        revision: 9,
      },
    }))
    chain(reopened)

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    for (const application of reopened) {
      expect(rows.find((row) => row.jobPostingId === application.jobPostingId)).toMatchObject({
        status: application.status,
        canCorrectOutcome: false,
        outcome: {
          roundsCompleted: 2,
          latestResult: 'advanced',
          latestRound: 2,
          latestReportedAt: '2026-07-13T08:00:00.000Z',
          revision: 9,
        },
      })
    }
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('requires a positive revision for correction without capping a long-lived revision token', async () => {
    reset()
    const highRevision = app({
      status: 'interviewed',
      outcome: {
        askCount: 0,
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: new Date('2026-07-13T08:00:00.000Z'),
        revision: 101,
      },
    })
    const legacyWithoutRevision = app({
      status: 'interviewed',
      outcome: {
        askCount: 0,
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: new Date('2026-07-13T08:00:00.000Z'),
      },
    })
    chain([highRevision, legacyWithoutRevision])

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === highRevision.jobPostingId)).toMatchObject({
      canCorrectOutcome: true,
      outcome: { revision: 101, latestResult: 'waiting', latestRound: 1 },
    })
    expect(rows.find((row) => row.jobPostingId === legacyWithoutRevision.jobPostingId)).toMatchObject({
      canCorrectOutcome: false,
      outcome: { revision: 0, roundsCompleted: 1 },
    })
  })

  it('projects Tailor and explicit applied-with metadata without exposing artifact text', async () => {
    reset()
    const tailored = app({
      tailoredVersion: {
        createdAt: NOW,
        tailoredText: 'MUST NEVER REACH TRACKER',
      },
      appliedWith: { wasTailored: true, tailoredFromResumeId: 'resume-private' },
    })
    chain([tailored])

    const row = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)[0]

    expect(row.tailoredResume).toEqual({ createdAt: NOW.toISOString() })
    expect(row.appliedWith).toEqual({ wasTailored: true })
    expect(JSON.stringify(row)).not.toContain('MUST NEVER REACH TRACKER')
    expect(JSON.stringify(row)).not.toContain('resume-private')
  })

  it('batches posting lifecycle and marks closed or missing rows without changing application status', async () => {
    reset()
    const live = app({ status: 'applied' })
    const closed = app({ status: 'interview_scheduled' })
    const missing = app({ status: 'offer' })
    chain([live, closed, missing])
    mockPostingFind.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve([
        { _id: live.jobPostingId, status: 'open' },
        { _id: closed.jobPostingId, status: 'closed', closedReason: 'aged-out' },
      ]) }),
    })

    const view = await getTracker('u1', NOW)
    const rows = view.groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === live.jobPostingId)).toMatchObject({ status: 'applied', postingState: 'live' })
    expect(rows.find((row) => row.jobPostingId === closed.jobPostingId)).toMatchObject({ status: 'interview_scheduled', postingState: 'archived' })
    expect(rows.find((row) => row.jobPostingId === missing.jobPostingId)).toMatchObject({ status: 'offer', postingState: 'snapshot-only' })
    expect(mockPostingFind).toHaveBeenCalledTimes(1)
  })

  it('suppresses positive preparation nudges when posting context is restricted or missing', async () => {
    reset()
    const restricted = app({
      status: 'applied',
      statusHistory: [{ status: 'applied', at: daysAgo(8), source: 'user' }],
      tailoredVersion: { createdAt: NOW, tailoredText: 'restricted artifact' },
    })
    const missing = app({ status: 'applied', statusHistory: [{ status: 'applied', at: daysAgo(22), source: 'user' }] })
    chain([restricted, missing])
    mockPostingFind.mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve([
        { _id: restricted.jobPostingId, status: 'closed', closedReason: 'source-revoked' },
      ]) }),
    })

    const rows = (await getTracker('u1', NOW)).groups.flatMap((group) => group.rows)

    expect(rows.find((row) => row.jobPostingId === restricted.jobPostingId)).toMatchObject({ postingState: 'restricted', nudge: null })
    expect(rows.find((row) => row.jobPostingId === restricted.jobPostingId)?.tailoredResume).toBeUndefined()
    expect(rows.find((row) => row.jobPostingId === missing.jobPostingId)).toMatchObject({ postingState: 'snapshot-only', nudge: null })
  })

  it('confirm card: freshest apply_clicked row inside 20h-7d, gated by the ask budget', async () => {
    reset()
    chain([
      app({
        status: 'apply_clicked',
        statusHistory: [{ status: 'apply_clicked', at: daysAgo(1), source: 'system' }],
        jobSnapshot: { title: 'SDE', company: 'Meesho', location: '' },
        tailoredVersion: { createdAt: NOW },
      }),
      app({ status: 'apply_clicked', statusHistory: [{ status: 'apply_clicked', at: daysAgo(0, 2), source: 'system' }] }), // too fresh (2h)
      app({ status: 'apply_clicked', statusHistory: [{ status: 'apply_clicked', at: daysAgo(9), source: 'system' }] }), // too old
      app({ status: 'apply_clicked', statusHistory: [{ status: 'apply_clicked', at: daysAgo(2), source: 'system' }], outcome: { askCount: 1 } }), // ONE dismissal retires the card
    ])
    const v = await getTracker('u1', NOW)
    expect(v.confirmCard).toMatchObject({
      company: 'Meesho',
      tailoredResume: { createdAt: NOW.toISOString() },
    })
  })

  it('a single dismissal retires the card — no double-dismiss (Codex #523)', async () => {
    reset()
    chain([app({ status: 'apply_clicked', statusHistory: [{ status: 'apply_clicked', at: daysAgo(1), source: 'system' }], outcome: { askCount: 1 } })])
    const v = await getTracker('u1', NOW)
    expect(v.confirmCard).toBeNull()
    // the row still offers the one-tap flip
    expect(v.groups.flatMap((g) => g.rows)[0].unconfirmedClick).toBe(true)
  })

  it('no eligible row → no confirm card', async () => {
    reset()
    chain([app({ status: 'applied' })])
    const v = await getTracker('u1', NOW)
    expect(v.confirmCard).toBeNull()
  })
})

describe('confirm-card budget + notes', () => {
  it('dismiss spends one ask; notes clamp to 2000', async () => {
    reset()
    await dismissConfirmCard('u1', 'j1')
    expect(mockUpdateOne.mock.calls[0][1]).toEqual({ $inc: { 'outcome.askCount': 1 } })
    await saveNotes('u1', 'j1', 'x'.repeat(3000))
    expect(mockUpdateOne.mock.calls[1][1].$set.notes).toHaveLength(2000)
  })

  it('inactive accounts cannot spend the ask budget or write notes', async () => {
    reset()
    mockWithActiveJobsAccountWrite.mockRejectedValue(new JobsAccountInactiveError('u1'))

    await expect(dismissConfirmCard('u1', 'j1')).rejects.toBeInstanceOf(JobsAccountInactiveError)
    await expect(saveNotes('u1', 'j1', 'private note')).rejects.toBeInstanceOf(JobsAccountInactiveError)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })
})
