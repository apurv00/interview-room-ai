import { describe, it, expect, vi } from 'vitest'

const {
  mockUpdateOne,
  mockWithActiveJobsAccountWrite,
  mockDbSession,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    mockUpdateOne: vi.fn(),
    mockWithActiveJobsAccountWrite: vi.fn(),
    mockDbSession: { id: 'jobs-account-session' },
    MockJobsAccountInactiveError,
  }
})
vi.mock('@shared/db/models', () => ({ JobApplication: { updateOne: mockUpdateOne } }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { buildPrepPlan, dateForChoice, calendarDaysBetween } from '../config/prepPlan'
import { setInterviewDate } from '../services/prepPlanService'

const NOW = new Date('2026-07-15T09:00:00Z')
const day = 24 * 3600_000
const CURRENT_STATE = { interviewRounds: 2, outcomeRevision: 7 } as const

describe('buildPrepPlan (§4c — instant, deterministic, no LLM)', () => {
  it('≥3 days → 3 sessions: today / midpoint / day-before', () => {
    const plan = buildPrepPlan(new Date(NOW.getTime() + 6 * day), NOW)
    expect(plan.mode).toBe('three-session')
    expect(plan.sessions.map((s) => s.dayOffset)).toEqual([0, 3, 5])
    expect(plan.headline).toContain('saved interview date')
    expect(plan.headline).not.toMatch(/evidence|readiness/i)
  })

  it('1-2 days → two focused sessions; interview day → warm-up only', () => {
    expect(buildPrepPlan(new Date(NOW.getTime() + 2 * day), NOW).sessions.map((s) => s.dayOffset)).toEqual([0, 1])
    const today = buildPrepPlan(new Date(NOW.getTime() + 3 * 3600_000), NOW)
    expect(today.sessions).toHaveLength(1)
    expect(today.sessions[0].dayOffset).toBe(0)
  })

  it('unknown date → start now', () => {
    const plan = buildPrepPlan(null, NOW)
    expect(plan.mode).toBe('start-now')
    expect(plan.sessions).toEqual([{ label: 'Session 1 — start now', dayOffset: 0 }])
  })
})

describe('calendar-day arithmetic (Codex #525 — Tomorrow never decays to today)', () => {
  it("'tomorrow' still plans two sessions when rendered hours after capture", () => {
    const captured = dateForChoice('tomorrow', NOW).date!
    const sixHoursLater = new Date(NOW.getTime() + 6 * 3600_000)
    const plan = buildPrepPlan(captured, sixHoursLater)
    expect(plan.mode).toBe('two-session')
    expect(plan.sessions).toHaveLength(2)
  })

  it('calendarDaysBetween counts IST calendar days, not 24h buckets', () => {
    expect(calendarDaysBetween(new Date('2026-07-15T18:00:00Z'), new Date('2026-07-15T19:00:00Z'))).toBe(1)
    expect(calendarDaysBetween(new Date('2026-07-15T23:00:00Z'), new Date('2026-07-16T01:00:00Z'))).toBe(0)
    expect(calendarDaysBetween(NOW, new Date(NOW.getTime() + 6 * day))).toBe(6)
  })
})

describe('dateForChoice (server owns the date math)', () => {
  it('maps the sheet buttons deterministically', () => {
    expect(dateForChoice('tomorrow', NOW)).toEqual({ date: new Date('2026-07-16T00:00:00.000Z'), confidence: 'exact' })
    expect(dateForChoice('this-week', NOW)).toEqual({ date: null, confidence: 'week', preference: 'this-week' })
    expect(dateForChoice('next-week', NOW)).toEqual({ date: null, confidence: 'week', preference: 'next-week' })
    expect(dateForChoice('not-sure', NOW)).toEqual({ date: null, confidence: 'unknown', preference: 'unknown' })
  })

  it('maps tomorrow across the IST Sunday-to-Monday boundary', () => {
    expect(dateForChoice('tomorrow', new Date('2026-07-19T19:00:00.000Z')).date).toEqual(
      new Date('2026-07-21T00:00:00.000Z'),
    )
  })
})

describe('setInterviewDate', () => {
  it('persists date+confidence and reports daysUntil; not-sure unsets the date', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    const r = await setInterviewDate(
      'u1',
      'j1',
      { date: new Date(NOW.getTime() + 6 * day), confidence: 'exact' },
      CURRENT_STATE,
      NOW,
    )
    expect(r).toEqual({ ok: true, daysUntil: 6 })
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({
      userId: 'u1',
      jobPostingId: 'j1',
      status: 'interview_scheduled',
      $and: [
        { 'outcome.interviewRounds': 2 },
        { 'outcome.revision': 7 },
      ],
    })
    expect(mockUpdateOne.mock.calls[0][1].$set).toMatchObject({ interviewDateConfidence: 'exact' })
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ session: mockDbSession })

    const r2 = await setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      CURRENT_STATE,
      NOW,
    )
    expect(r2).toEqual({ ok: true, daysUntil: null })
    expect(mockUpdateOne.mock.calls[1][1].$unset).toEqual({ interviewDate: 1 })
    expect(mockUpdateOne.mock.calls[1][1].$set).toMatchObject({
      interviewDateConfidence: 'unknown',
      interviewDatePreference: 'unknown',
    })
  })

  it('persists a week answer only as a preference and removes any exact date', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )

    const result = await setInterviewDate('u1', 'j1', dateForChoice('this-week', NOW), CURRENT_STATE, NOW)

    expect(result).toEqual({ ok: true, daysUntil: null })
    expect(mockUpdateOne.mock.calls[0][1]).toMatchObject({
      $set: { interviewDateConfidence: 'week', interviewDatePreference: 'this-week' },
      $unset: { interviewDate: 1 },
    })
  })

  it('rejects nonsense dates, missing rows, and rows no longer scheduled', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    expect((await setInterviewDate(
      'u1',
      'j1',
      { date: new Date(NOW.getTime() - 3 * day), confidence: 'exact' },
      CURRENT_STATE,
      NOW,
    )).ok).toBe(false)
    expect((await setInterviewDate(
      'u1',
      'j1',
      { date: new Date(NOW.getTime() + 400 * day), confidence: 'exact' },
      CURRENT_STATE,
      NOW,
    )).ok).toBe(false)
    expect(mockUpdateOne).not.toHaveBeenCalled()
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      CURRENT_STATE,
      NOW,
    )).resolves.toEqual({ ok: false, daysUntil: null, reason: 'state-conflict' })
  })

  it('matches legacy missing counters only when the displayed state token is zero', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )

    await setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      { interviewRounds: 0, outcomeRevision: 0 },
      NOW,
    )

    expect(mockUpdateOne.mock.calls[0][0]).toMatchObject({
      $and: [
        { $or: [{ 'outcome.interviewRounds': 0 }, { 'outcome.interviewRounds': { $exists: false } }] },
        { $or: [{ 'outcome.revision': 0 }, { 'outcome.revision': { $exists: false } }] },
      ],
    })
  })

  it('rejects an old timing token after an outcome update advances the round and revision', async () => {
    mockUpdateOne.mockReset()
      .mockResolvedValueOnce({ matchedCount: 1 })
      // Models the outcome transaction committing round 2 / revision 4
      // before the second timing write reaches Mongo.
      .mockResolvedValueOnce({ matchedCount: 0 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    const oldToken = { interviewRounds: 1, outcomeRevision: 3 }
    const capture = { date: null, confidence: 'unknown' as const, preference: 'unknown' as const }

    await expect(setInterviewDate('u1', 'j1', capture, oldToken, NOW)).resolves.toEqual({
      ok: true,
      daysUntil: null,
    })
    await expect(setInterviewDate('u1', 'j1', capture, oldToken, NOW)).resolves.toEqual({
      ok: false,
      daysUntil: null,
      reason: 'state-conflict',
    })
    expect(mockUpdateOne.mock.calls[1][0]).toMatchObject({
      status: 'interview_scheduled',
      $and: [
        { 'outcome.interviewRounds': 1 },
        { 'outcome.revision': 3 },
      ],
    })
  })

  it('rejects an old timing token after scheduled → ghosted → scheduled lifecycle ABA', async () => {
    mockUpdateOne.mockReset().mockResolvedValueOnce({ matchedCount: 0 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )

    await expect(setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      { interviewRounds: 1, outcomeRevision: 5 },
      NOW,
    )).resolves.toEqual({ ok: false, daysUntil: null, reason: 'state-conflict' })

    expect(mockUpdateOne.mock.calls[0][0]).toMatchObject({
      status: 'interview_scheduled',
      $and: [
        { 'outcome.interviewRounds': 1 },
        { 'outcome.revision': 5 },
      ],
    })
  })

  it('rejects malformed state tokens before opening the account write fence', async () => {
    mockUpdateOne.mockReset()
    mockWithActiveJobsAccountWrite.mockReset()

    await expect(setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      { interviewRounds: 101, outcomeRevision: 1 },
      NOW,
    )).resolves.toEqual({ ok: false, daysUntil: null, reason: 'invalid' })
    await expect(setInterviewDate(
      'u1',
      'j1',
      { date: null, confidence: 'unknown', preference: 'unknown' },
      { interviewRounds: 1, outcomeRevision: -1 },
      NOW,
    )).resolves.toEqual({ ok: false, daysUntil: null, reason: 'invalid' })
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })

  it('preserves the inactive-account signal and writes nothing when deletion owns the fence', async () => {
    mockUpdateOne.mockReset()
    mockWithActiveJobsAccountWrite.mockReset().mockRejectedValue(
      new MockJobsAccountInactiveError('account deleting'),
    )

    await expect(
      setInterviewDate(
        'u1',
        'j1',
        { date: null, confidence: 'unknown', preference: 'unknown' },
        CURRENT_STATE,
        NOW,
      ),
    ).rejects.toBeInstanceOf(MockJobsAccountInactiveError)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })
})
