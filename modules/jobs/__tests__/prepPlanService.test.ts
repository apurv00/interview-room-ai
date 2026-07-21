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

describe('buildPrepPlan (§4c — instant, deterministic, no LLM)', () => {
  it('≥3 days → 3 sessions: today / midpoint / day-before', () => {
    const plan = buildPrepPlan(new Date(NOW.getTime() + 6 * day), NOW)
    expect(plan.mode).toBe('three-session')
    expect(plan.sessions.map((s) => s.dayOffset)).toEqual([0, 3, 5])
    expect(plan.headline).toContain('mocks built from this JD') // Phase-1 copy, no per-session tags
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

  it('calendarDaysBetween counts calendar days, not 24h buckets', () => {
    expect(calendarDaysBetween(new Date('2026-07-15T23:00:00Z'), new Date('2026-07-16T01:00:00Z'))).toBe(1)
    expect(calendarDaysBetween(NOW, new Date(NOW.getTime() + 6 * day))).toBe(6)
  })
})

describe('dateForChoice (server owns the date math)', () => {
  it('maps the sheet buttons deterministically', () => {
    expect(dateForChoice('tomorrow', NOW)).toEqual({ date: new Date(NOW.getTime() + day), confidence: 'exact' })
    expect(dateForChoice('this-week', NOW).confidence).toBe('week')
    expect(dateForChoice('next-week', NOW).date!.getTime()).toBe(NOW.getTime() + 9 * day)
    expect(dateForChoice('not-sure', NOW)).toEqual({ date: null, confidence: 'unknown' })
  })
})

describe('setInterviewDate', () => {
  it('persists date+confidence and reports daysUntil; not-sure unsets the date', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    const r = await setInterviewDate('u1', 'j1', { date: new Date(NOW.getTime() + 6 * day), confidence: 'exact' }, NOW)
    expect(r).toEqual({ ok: true, daysUntil: 6 })
    expect(mockUpdateOne.mock.calls[0][1].$set).toMatchObject({ interviewDateConfidence: 'exact' })
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ session: mockDbSession })

    const r2 = await setInterviewDate('u1', 'j1', { date: null, confidence: 'unknown' }, NOW)
    expect(r2).toEqual({ ok: true, daysUntil: null })
    expect(mockUpdateOne.mock.calls[1][1].$unset).toEqual({ interviewDate: 1 })
  })

  it('rejects nonsense dates (past beyond yesterday, >1y out) and missing rows', async () => {
    mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 })
    mockWithActiveJobsAccountWrite.mockReset().mockImplementation(
      async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(mockDbSession),
    )
    expect((await setInterviewDate('u1', 'j1', { date: new Date(NOW.getTime() - 3 * day), confidence: 'exact' }, NOW)).ok).toBe(false)
    expect((await setInterviewDate('u1', 'j1', { date: new Date(NOW.getTime() + 400 * day), confidence: 'exact' }, NOW)).ok).toBe(false)
    expect(mockUpdateOne).not.toHaveBeenCalled()
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })
    expect((await setInterviewDate('u1', 'j1', { date: null, confidence: 'unknown' }, NOW)).ok).toBe(false)
  })

  it('preserves the inactive-account signal and writes nothing when deletion owns the fence', async () => {
    mockUpdateOne.mockReset()
    mockWithActiveJobsAccountWrite.mockReset().mockRejectedValue(
      new MockJobsAccountInactiveError('account deleting'),
    )

    await expect(
      setInterviewDate('u1', 'j1', { date: null, confidence: 'unknown' }, NOW),
    ).rejects.toBeInstanceOf(MockJobsAccountInactiveError)
    expect(mockUpdateOne).not.toHaveBeenCalled()
  })
})
