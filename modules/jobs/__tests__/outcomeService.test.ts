import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Types } from 'mongoose'

const {
  mockFindOne,
  mockSelect,
  mockSessionQuery,
  mockLean,
  mockUpdateOne,
  mockCreateEvent,
  mockWithActiveJobsAccountWrite,
} = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockSelect: vi.fn(),
  mockSessionQuery: vi.fn(),
  mockLean: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
}))

vi.mock('@shared/db/models', () => ({
  JobApplication: { findOne: mockFindOne, updateOne: mockUpdateOne },
  ProductEvent: { create: mockCreateEvent },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { recordInterviewOutcome } from '../services/outcomeService'

const NOW = new Date('2026-07-22T12:00:00.000Z')
const INTERVIEW_DATE = new Date('2026-07-22T09:00:00.000Z')
const OLD_INTERVIEWED_AT = new Date('2026-07-15T09:00:00.000Z')
const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const APPLICATION_ID = new Types.ObjectId('507f1f77bcf86cd799439012')
const SESSION = { id: 'transaction-session' }

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    _id: APPLICATION_ID,
    status: 'interview_scheduled',
    outcome: { interviewRounds: 0, askCount: 0 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockFindOne.mockReturnValue({ select: mockSelect })
  mockSelect.mockReturnValue({ session: mockSessionQuery })
  mockSessionQuery.mockReturnValue({ lean: mockLean })
  mockLean.mockResolvedValue(snapshot())
  mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  mockCreateEvent.mockResolvedValue([])
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: never) => Promise<unknown>) => work(SESSION as never),
  )
})

describe('recordInterviewOutcome', () => {
  it('atomically completes exactly the next scheduled round and uses its exact past date', async () => {
    mockLean.mockResolvedValue(snapshot({
      interviewDate: INTERVIEW_DATE,
      interviewDateConfidence: 'exact',
    }))

    const result = await recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'waiting', round: 1 },
      NOW,
    )

    expect(result).toEqual({
      ok: true,
      changed: true,
      deferred: false,
      status: 'interviewed',
      outcome: {
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: NOW,
        revision: 1,
        lastInterviewedAt: INTERVIEW_DATE,
        askCount: 0,
      },
    })
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith(USER_ID, expect.any(Function))
    expect(mockSessionQuery).toHaveBeenCalledWith(SESSION)
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: APPLICATION_ID,
        userId: USER_ID,
        jobPostingId: JOB_ID,
        status: 'interview_scheduled',
        'outcome.interviewRounds': 0,
        'outcome.revision': { $exists: false },
      }),
      {
        $set: {
          status: 'interviewed',
          'outcome.interviewRounds': 1,
          'outcome.latestResult': 'waiting',
          'outcome.latestRound': 1,
          'outcome.latestReportedAt': NOW,
          'outcome.revision': 1,
          'outcome.offerReceived': false,
          'outcome.lastInterviewedAt': INTERVIEW_DATE,
        },
        $unset: {
          interviewDate: 1,
          interviewDateConfidence: 1,
          interviewDatePreference: 1,
        },
        $push: {
          statusHistory: { status: 'interviewed', at: NOW, source: 'user' },
        },
      },
      { session: SESSION },
    )
    expect(mockCreateEvent).toHaveBeenCalledWith([{
      name: 'jobs.outcome_reported',
      userId: USER_ID,
      jobPostingId: JOB_ID,
      applicationId: APPLICATION_ID,
      props: {
        result: 'waiting',
        round: 1,
        correction: false,
        followUp: false,
        revision: 1,
        offer: false,
        fromStatus: 'interview_scheduled',
        toStatus: 'interviewed',
      },
      ts: NOW,
    }], { session: SESSION })
  })

  it('falls back to report time when an exact interview date is in the future', async () => {
    mockLean.mockResolvedValue(snapshot({
      interviewDate: new Date('2026-07-23T09:00:00.000Z'),
      interviewDateConfidence: 'exact',
    }))

    await recordInterviewOutcome(USER_ID, JOB_ID, { result: 'advanced', round: 1 }, NOW)

    expect(mockUpdateOne.mock.calls[0][1].$set['outcome.lastInterviewedAt']).toEqual(NOW)
  })

  it('makes a same-result same-round retry a no-op with no history or event', async () => {
    mockLean.mockResolvedValue(snapshot({
      status: 'interviewed',
      outcome: {
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: NOW,
        revision: 1,
        lastInterviewedAt: INTERVIEW_DATE,
        askCount: 0,
      },
    }))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'waiting', round: 1 },
      NOW,
    )).resolves.toMatchObject({ ok: true, changed: false, deferred: false })

    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('corrects only the canonical latest round without incrementing or replacing attendance time', async () => {
    mockLean.mockResolvedValue(snapshot({
      status: 'rejected',
      outcome: {
        interviewRounds: 2,
        latestResult: 'rejected',
        latestRound: 2,
        latestReportedAt: new Date('2026-07-21T12:00:00.000Z'),
        revision: 7,
        lastInterviewedAt: OLD_INTERVIEWED_AT,
        askCount: 1,
      },
    }))

    const result = await recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'offer',
        round: 2,
        expectedRevision: 7,
        expectedStatus: 'rejected',
      },
      NOW,
    )

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      status: 'offer',
      outcome: { interviewRounds: 2, revision: 8, lastInterviewedAt: OLD_INTERVIEWED_AT },
    })
    const update = mockUpdateOne.mock.calls[0][1]
    expect(update.$set).toMatchObject({
      status: 'offer',
      'outcome.interviewRounds': 2,
      'outcome.revision': 8,
      'outcome.offerReceived': true,
    })
    expect(update.$set).not.toHaveProperty('outcome.passedScreen')
    expect(update.$set).not.toHaveProperty('outcome.lastInterviewedAt')
    expect(mockCreateEvent.mock.calls[0][0][0].props).toMatchObject({
      correction: true,
      followUp: false,
      revision: 8,
      fromStatus: 'rejected',
      toStatus: 'offer',
    })
  })

  it('classifies a decision reported after waiting as a follow-up, not a correction', async () => {
    mockLean.mockResolvedValue(snapshot({
      status: 'interviewed',
      outcome: {
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: OLD_INTERVIEWED_AT,
        revision: 3,
        lastInterviewedAt: OLD_INTERVIEWED_AT,
        askCount: 0,
      },
    }))

    await recordInterviewOutcome(USER_ID, JOB_ID, {
      result: 'offer',
      round: 1,
      expectedRevision: 3,
      expectedStatus: 'interviewed',
    }, NOW)

    expect(mockCreateEvent.mock.calls[0][0][0].props).toMatchObject({
      correction: false,
      followUp: true,
      revision: 4,
      fromStatus: 'interviewed',
      toStatus: 'offer',
    })
  })

  it('rejects corrections with either a stale revision or a mismatched lifecycle status', async () => {
    const canonicalSnapshot = snapshot({
      status: 'interviewed',
      outcome: {
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: OLD_INTERVIEWED_AT,
        revision: 3,
        lastInterviewedAt: OLD_INTERVIEWED_AT,
        askCount: 0,
      },
    })
    mockLean
      .mockResolvedValueOnce(canonicalSnapshot)
      .mockResolvedValueOnce(canonicalSnapshot)

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'offer',
        round: 1,
        expectedRevision: 2,
        expectedStatus: 'interviewed',
      },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 1 })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'offer',
        round: 1,
        expectedRevision: 3,
        expectedStatus: 'rejected',
      },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 1 })

    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('rejects a token from before rejected → applied → rejected lifecycle ABA', async () => {
    mockLean.mockResolvedValue(snapshot({
      status: 'rejected',
      outcome: {
        interviewRounds: 2,
        latestResult: 'rejected',
        latestRound: 2,
        latestReportedAt: OLD_INTERVIEWED_AT,
        revision: 9,
        lastInterviewedAt: OLD_INTERVIEWED_AT,
        askCount: 0,
      },
    }))

    await expect(recordInterviewOutcome(USER_ID, JOB_ID, {
      result: 'offer',
      round: 2,
      expectedRevision: 7,
      expectedStatus: 'rejected',
    }, NOW)).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 2 })
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('increments the monotonic revision across an A to B to A cycle and rejects the original token', async () => {
    const reportedAtB = new Date('2026-07-22T12:01:00.000Z')
    const reportedAtAAgain = new Date('2026-07-22T12:02:00.000Z')
    mockLean
      .mockResolvedValueOnce(snapshot({
        status: 'interviewed',
        outcome: {
          interviewRounds: 1,
          latestResult: 'waiting',
          latestRound: 1,
          latestReportedAt: OLD_INTERVIEWED_AT,
          revision: 1,
          lastInterviewedAt: OLD_INTERVIEWED_AT,
          askCount: 0,
        },
      }))
      .mockResolvedValueOnce(snapshot({
        status: 'rejected',
        outcome: {
          interviewRounds: 1,
          latestResult: 'rejected',
          latestRound: 1,
          latestReportedAt: NOW,
          revision: 2,
          lastInterviewedAt: OLD_INTERVIEWED_AT,
          askCount: 0,
        },
      }))
      .mockResolvedValueOnce(snapshot({
        status: 'interviewed',
        outcome: {
          interviewRounds: 1,
          latestResult: 'waiting',
          latestRound: 1,
          latestReportedAt: reportedAtB,
          revision: 3,
          lastInterviewedAt: OLD_INTERVIEWED_AT,
          askCount: 0,
        },
      }))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'rejected',
        round: 1,
        expectedRevision: 1,
        expectedStatus: 'interviewed',
      },
      NOW,
    )).resolves.toMatchObject({
      ok: true,
      changed: true,
      status: 'rejected',
      outcome: { latestResult: 'rejected', revision: 2 },
    })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'waiting',
        round: 1,
        expectedRevision: 2,
        expectedStatus: 'rejected',
      },
      reportedAtB,
    )).resolves.toMatchObject({
      ok: true,
      changed: true,
      status: 'interviewed',
      outcome: { latestResult: 'waiting', revision: 3 },
    })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'waiting',
        round: 1,
        expectedRevision: 1,
        expectedStatus: 'interviewed',
      },
      reportedAtAAgain,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 1 })

    expect(mockUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockUpdateOne.mock.calls[0][1].$set['outcome.revision']).toBe(2)
    expect(mockUpdateOne.mock.calls[1][1].$set['outcome.revision']).toBe(3)
    expect(mockCreateEvent).toHaveBeenCalledTimes(2)
    expect(mockCreateEvent.mock.calls.map(([events]) => events[0].props.revision)).toEqual([2, 3])
  })

  it('accepts token-bearing same-report no-ops for the current token and a committed retry', async () => {
    mockLean
      .mockResolvedValueOnce(snapshot({
        status: 'interviewed',
        outcome: {
          interviewRounds: 1,
          latestResult: 'waiting',
          latestRound: 1,
          latestReportedAt: NOW,
          revision: 3,
          askCount: 0,
        },
      }))
      .mockResolvedValueOnce(snapshot({
        status: 'offer',
        outcome: {
          interviewRounds: 1,
          latestResult: 'offer',
          latestRound: 1,
          latestReportedAt: NOW,
          revision: 4,
          askCount: 0,
        },
      }))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'waiting',
        round: 1,
        expectedRevision: 3,
        expectedStatus: 'interviewed',
      },
      NOW,
    )).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: { latestResult: 'waiting', revision: 3 },
    })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'offer',
        round: 1,
        expectedRevision: 3,
        expectedStatus: 'rejected',
      },
      NOW,
    )).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: { latestResult: 'offer', revision: 4 },
    })

    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('rejects a token-bearing same report after its lifecycle status changed independently', async () => {
    mockLean.mockResolvedValueOnce(snapshot({
      status: 'withdrawn',
      outcome: {
        interviewRounds: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: NOW,
        revision: 3,
        askCount: 0,
      },
    }))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      {
        result: 'waiting',
        round: 1,
        expectedRevision: 3,
        expectedStatus: 'interviewed',
      },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 1 })
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('rejects stale, skipped, and fabricated round reports', async () => {
    mockLean
      .mockResolvedValueOnce(snapshot({
        outcome: { interviewRounds: 2, latestResult: 'advanced', latestRound: 2, askCount: 0 },
      }))
      .mockResolvedValueOnce(snapshot({ status: 'apply_clicked' }))
      .mockResolvedValueOnce(snapshot({ status: 'saved' }))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'rejected', round: 1 },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict', currentRound: 2 })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'offer', round: 1 },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'ineligible', currentRound: 0 })
    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'skip', round: 1 },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'ineligible', currentRound: 0 })
    expect(mockUpdateOne).not.toHaveBeenCalled()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('records skip only once without changing the canonical revision or emitting an event', async () => {
    mockLean
      .mockResolvedValueOnce(snapshot({
        outcome: {
          interviewRounds: 1,
          latestResult: 'advanced',
          latestRound: 1,
          latestReportedAt: OLD_INTERVIEWED_AT,
          revision: 7,
          askCount: 0,
        },
      }))
      .mockResolvedValueOnce(snapshot({
        outcome: {
          interviewRounds: 1,
          latestResult: 'advanced',
          latestRound: 1,
          latestReportedAt: OLD_INTERVIEWED_AT,
          revision: 7,
          lastDeferredRound: 2,
          lastAskedAt: NOW,
          askCount: 1,
        },
      }))

    const first = await recordInterviewOutcome(USER_ID, JOB_ID, { result: 'skip', round: 2 }, NOW)
    const retry = await recordInterviewOutcome(USER_ID, JOB_ID, { result: 'skip', round: 2 }, NOW)

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      deferred: true,
      outcome: {
        interviewRounds: 1,
        revision: 7,
        lastDeferredRound: 2,
        lastAskedAt: NOW,
        askCount: 1,
      },
    })
    expect(retry).toMatchObject({ ok: true, changed: false, deferred: true })
    expect(mockUpdateOne).toHaveBeenCalledOnce()
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        'outcome.revision': 7,
        'outcome.lastDeferredRound': { $exists: false },
      }),
      {
        $set: { 'outcome.lastDeferredRound': 2, 'outcome.lastAskedAt': NOW },
        $inc: { 'outcome.askCount': 1 },
      },
      { session: SESSION },
    )
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('retries a lost snapshot CAS and emits exactly once for the winning transaction', async () => {
    mockLean.mockResolvedValue(snapshot())
    mockUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'advanced', round: 1 },
      NOW,
    )).resolves.toMatchObject({ ok: true, changed: true })

    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledTimes(2)
    expect(mockUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockCreateEvent).toHaveBeenCalledOnce()
  })

  it('returns a stale-round conflict after bounded repeated snapshot losses', async () => {
    mockLean.mockResolvedValue(snapshot({
      outcome: { interviewRounds: 2, latestResult: 'advanced', latestRound: 2, askCount: 0 },
    }))
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'waiting', round: 3 },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'round-conflict' })
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledTimes(2)
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })

  it('propagates event failure from the same transaction instead of reporting success', async () => {
    mockCreateEvent.mockRejectedValueOnce(new Error('event insert failed'))

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'rejected', round: 1 },
      NOW,
    )).rejects.toThrow('event insert failed')
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ session: SESSION })
    expect(mockCreateEvent.mock.calls[0][1]).toEqual({ session: SESSION })
  })

  it('returns not-found for a non-owner application lookup', async () => {
    mockLean.mockResolvedValueOnce(null)

    await expect(recordInterviewOutcome(
      USER_ID,
      JOB_ID,
      { result: 'advanced', round: 1 },
      NOW,
    )).resolves.toEqual({ ok: false, reason: 'not-found' })
    expect(mockFindOne).toHaveBeenCalledWith({ userId: USER_ID, jobPostingId: JOB_ID })
  })
})
