import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'
import { JobApplication as RealJobApplication } from '@shared/db/models/JobApplication'

const { mockPostingFindById, mockPostingUpdateOne, mockPostingExists, mockAppFindOne, mockAppUpdateOne, mockAppCreate, mockAppFindOneAndUpdate, mockAppDeleteOne, mockStartSession, mockWithTransaction, mockEndSession } = vi.hoisted(() => ({
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockPostingExists: vi.fn(),
  mockAppFindOne: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockAppCreate: vi.fn(),
  mockAppFindOneAndUpdate: vi.fn(),
  mockAppDeleteOne: vi.fn(),
  mockStartSession: vi.fn(),
  mockWithTransaction: vi.fn(),
  mockEndSession: vi.fn(),
}))
const { mockSessionFindById, mockSessionFindOne, mockSessionUpdateOne } = vi.hoisted(() => ({
  mockSessionFindById: vi.fn(),
  mockSessionFindOne: vi.fn(),
  mockSessionUpdateOne: vi.fn(),
}))
const {
  mockInngestSend,
  mockIsJobsAccountActive,
  mockWithActiveJobsAccountWrite,
  mockRecordJobsUserEvent,
} = vi.hoisted(() => ({
  mockInngestSend: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne, exists: mockPostingExists },
  JobApplication: {
    findOne: mockAppFindOne,
    updateOne: mockAppUpdateOne,
    create: mockAppCreate,
    findOneAndUpdate: mockAppFindOneAndUpdate,
    deleteOne: mockAppDeleteOne,
  },
  InterviewSession: { findById: mockSessionFindById, findOne: mockSessionFindOne, updateOne: mockSessionUpdateOne },
}))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mockInngestSend } }))
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
vi.mock('../services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))

import {
  recordApplyClick,
  claimAtsRun,
  transitionStatus,
  reportBrokenLink,
  recordPracticeEvidence,
  saveTailoredVersion,
  hasCompletedScoredPractice,
} from '../services/applicationService'
import { xrayHashOf } from '../services/xrayService'
import { practiceHandoffHashOf } from '../services/practiceHandoff'
import { applyOptionIdOf } from '../services/applyOptionIdentity'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const NOW = new Date('2026-07-14T12:00:00Z')
const PRACTICE_JD = 'Backend engineer building Node.js and MongoDB payment systems. '.repeat(3)
const PRACTICE_JD_COMPRESSED = gzipSync(Buffer.from(PRACTICE_JD))
const PRACTICE_JD_HASH = practiceHandoffHashOf(PRACTICE_JD)
const APPLY_SOURCE = {
  sourceId: 'jsearch',
  sourceKey: 'jsearch:1',
  applyUrl: 'https://x.example/apply',
  applyTier: 'direct-ats' as const,
}
const APPLY_OPTION_ID = applyOptionIdOf({
  sourceKey: APPLY_SOURCE.sourceKey,
  url: APPLY_SOURCE.applyUrl,
  tier: APPLY_SOURCE.applyTier,
})

function reset(posting: unknown = { title: 'SDE', company: 'PhonePe', locations: ['Pune'], provenance: [APPLY_SOURCE], status: 'open', jdCompressed: PRACTICE_JD_COMPRESSED }) {
  for (const m of [mockPostingFindById, mockPostingUpdateOne, mockPostingExists, mockAppFindOne, mockAppUpdateOne, mockAppCreate, mockAppFindOneAndUpdate, mockAppDeleteOne, mockSessionFindOne, mockSessionUpdateOne, mockIsJobsAccountActive, mockWithActiveJobsAccountWrite, mockRecordJobsUserEvent, mockStartSession, mockWithTransaction, mockEndSession]) m.mockReset()
  mockInngestSend.mockReset()
  mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(posting) }) })
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  mockPostingExists.mockResolvedValue({ _id: 'posting' })
  mockAppUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  mockAppCreate.mockResolvedValue([])
  mockAppDeleteOne.mockResolvedValue({ deletedCount: 1 })
  mockSessionUpdateOne.mockResolvedValue({})
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockInngestSend.mockResolvedValue(undefined)
  mockRecordJobsUserEvent.mockResolvedValue(true)
  mockWithTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
  mockStartSession.mockResolvedValue({
    withTransaction: mockWithTransaction,
    endSession: mockEndSession,
  })
  mockWithActiveJobsAccountWrite.mockImplementation(async (
    _userId: string,
    work: (session: unknown) => Promise<unknown> | unknown,
  ) => {
    const session = await mockStartSession()
    let result: unknown
    try {
      await session.withTransaction(async () => {
        result = await work(session)
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      })
      return result
    } finally {
      await session.endSession()
    }
  })
}

describe('recordApplyClick (machine fact — never conflated with the user claim)', () => {
  it('resolves the opaque option server-side, creates apply_clicked, and pins the exact rung', async () => {
    reset()
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    const r = await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)
    expect(r).toEqual({
      status: 'apply_clicked',
      created: true,
      transitioned: true,
      canonicalOption: { optionId: APPLY_OPTION_ID, tier: 'direct-ats' },
    })
    const created = mockAppCreate.mock.calls[0][0][0]
    expect(created.status).toBe('apply_clicked')
    expect(created.statusHistory[0]).toMatchObject({ status: 'apply_clicked', source: 'system' })
    expect(created.jobSnapshot.applyTierAtClick).toBe('direct-ats')
    expect(created.jobSnapshot.applyUrlAtClick).toBe(APPLY_SOURCE.applyUrl)
    expect(created.clickedApplyOptionIds).toEqual([APPLY_OPTION_ID])
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'j1',
        status: 'open',
        closedReason: { $exists: false },
        provenance: {
          $elemMatch: {
            sourceKey: APPLY_SOURCE.sourceKey,
            applyUrl: APPLY_SOURCE.applyUrl,
            applyTier: APPLY_SOURCE.applyTier,
          },
        },
      },
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      expect.objectContaining({ session: expect.anything(), timestamps: false }),
    )
  })

  it('saved → apply_clicked transitions with a system history entry, guarded against races', async () => {
    reset()
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'app1', status: 'saved', clickedApplyOptionIds: [] }) }) })
    const r = await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)
    expect(r).toEqual({
      status: 'apply_clicked',
      created: false,
      transitioned: true,
      canonicalOption: { optionId: APPLY_OPTION_ID, tier: 'direct-ats' },
    })
    const [filter, update] = mockAppUpdateOne.mock.calls[0]
    expect(filter.status).toBe('saved') // race guard: a concurrent forward move wins
    expect(update.$set).toMatchObject({
      status: 'apply_clicked',
      'jobSnapshot.applyTierAtClick': 'direct-ats',
      'jobSnapshot.applyUrlAtClick': APPLY_SOURCE.applyUrl,
      clickedApplyOptionIds: [APPLY_OPTION_ID],
    })
    expect(update.$push.statusHistory).toMatchObject({ status: 'apply_clicked', source: 'system' })
  })

  it('never regresses a forward status but still records the canonical option actually clicked', async () => {
    for (const status of ['apply_clicked', 'applied', 'interview_scheduled', 'offer']) {
      reset()
      mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'app1', status, clickedApplyOptionIds: [] }) }) })
      const r = await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)
      expect(r).toEqual({
        status,
        created: false,
        transitioned: false,
        canonicalOption: { optionId: APPLY_OPTION_ID, tier: 'direct-ats' },
      })
      expect(mockAppUpdateOne).toHaveBeenCalledWith(
        { _id: 'app1', userId: 'u1', jobPostingId: 'j1' },
        { $set: { clickedApplyOptionIds: [APPLY_OPTION_ID] } },
        expect.objectContaining({ session: expect.anything() }),
      )
      expect(mockAppCreate).not.toHaveBeenCalled()
    }
  })

  it('unique-index race with a practice/save winner still preserves the Apply machine fact', async () => {
    reset()
    mockAppFindOne
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ _id: 'winner', status: 'saved', clickedApplyOptionIds: [] }) }) })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    const r = await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)
    expect(r).toMatchObject({ status: 'apply_clicked', created: false, transitioned: true })
    expect(mockAppUpdateOne).toHaveBeenCalledWith(
      { _id: 'winner', userId: 'u1', jobPostingId: 'j1', status: 'saved' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'apply_clicked', clickedApplyOptionIds: [APPLY_OPTION_ID] }),
        $push: { statusHistory: expect.objectContaining({ status: 'apply_clicked', source: 'system' }) },
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mockStartSession).toHaveBeenCalledTimes(2)
  })

  it('returns null when deletion wins between an Apply duplicate race and its retry', async () => {
    reset()
    mockAppFindOne.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    mockWithActiveJobsAccountWrite
      .mockImplementationOnce(async (_userId: string, work: (session: unknown) => Promise<unknown>) => work({ id: 'first' }))
      .mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    await expect(recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).resolves.toBeNull()
    expect(mockAppCreate).toHaveBeenCalledOnce()
  })

  it('unique-index race never regresses a winner that already advanced beyond saved', async () => {
    reset()
    mockAppFindOne
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ _id: 'winner', status: 'applied', clickedApplyOptionIds: [] }) }) })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))

    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({
      status: 'applied',
      created: false,
      transitioned: false,
      canonicalOption: { optionId: APPLY_OPTION_ID, tier: 'direct-ats' },
    })
    expect(mockAppUpdateOne).toHaveBeenLastCalledWith(
      { _id: 'winner', userId: 'u1', jobPostingId: 'j1' },
      { $set: { clickedApplyOptionIds: [APPLY_OPTION_ID] } },
      expect.objectContaining({ session: expect.anything() }),
    )
  })

  it('rejects missing/new closed ownership, but allows an existing owner on a normal archive', async () => {
    reset(null)
    expect(await recordApplyClick('u1', 'gone', APPLY_OPTION_ID, NOW)).toBeNull()
    reset({ title: 'SDE', company: 'X', locations: [], provenance: [APPLY_SOURCE], status: 'closed', closedReason: 'aged-out' })
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toBeNull()
    expect(mockAppCreate).not.toHaveBeenCalled()

    reset({ title: 'SDE', company: 'X', locations: [], provenance: [APPLY_SOURCE], status: 'closed', closedReason: 'aged-out' })
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'app1', status: 'saved', clickedApplyOptionIds: [] }) }) })
    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toMatchObject({
      status: 'apply_clicked', created: false, transitioned: true,
    })
  })

  it('rejects stale option ids and source-revoked closures before any application write', async () => {
    const replacement = { ...APPLY_SOURCE, applyUrl: 'https://x.example/replaced' }
    reset({ title: 'SDE', company: 'X', locations: [], provenance: [replacement], status: 'open' })
    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toBeNull()
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()

    reset({ title: 'SDE', company: 'X', locations: [], provenance: [APPLY_SOURCE], status: 'closed', closedReason: 'source-revoked' })
    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toBeNull()
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects an existing provenance rung whose host is now blocklisted', async () => {
    const blockedSource = { ...APPLY_SOURCE, applyUrl: 'https://wa.me/919876543210' }
    const blockedOptionId = applyOptionIdOf({
      sourceKey: blockedSource.sourceKey,
      url: blockedSource.applyUrl,
      tier: blockedSource.applyTier,
    })
    reset({
      title: 'SDE',
      company: 'X',
      locations: [],
      provenance: [blockedSource],
      status: 'open',
    })

    expect(await recordApplyClick('u1', 'j1', blockedOptionId, NOW)).toBeNull()
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppCreate).not.toHaveBeenCalled()
  })

  it('bounds distinct click history and keeps the latest canonical option idempotently', async () => {
    reset()
    const prior = Array.from({ length: 20 }, (_, index) => `legacy-${index}`)
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({
      _id: 'app1', status: 'applied', clickedApplyOptionIds: [...prior, APPLY_OPTION_ID],
    }) }) })

    await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)
    const next = mockAppUpdateOne.mock.calls[0][1].$set.clickedApplyOptionIds
    expect(next).toHaveLength(16)
    expect(next.at(-1)).toBe(APPLY_OPTION_ID)
    expect(next.filter((id: string) => id === APPLY_OPTION_ID)).toHaveLength(1)
  })

  it('does not mutate the application when the exact provenance/lifecycle pin loses', async () => {
    reset()
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) })
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toBeNull()
    expect(mockAppCreate).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('does not read, pin, or create when account deletion owns the write fence', async () => {
    reset()
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    expect(await recordApplyClick('u1', 'j1', APPLY_OPTION_ID, NOW)).toBeNull()
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockAppCreate).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})

describe('claimAtsRun (atomic single-enqueue claim, Codex #521)', () => {
  it('the winner flips the marker (modifiedCount 1); the loser does not enqueue', async () => {
    reset()
    mockPostingUpdateOne.mockReset()
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 })
    const win = await claimAtsRun('u1', 'j1')
    expect(win.claimed).toBe(true)
    expect(win.claimedAt).toBeInstanceOf(Date)
    const [filter] = mockAppUpdateOne.mock.calls[0]
    expect(filter.$or).toBeDefined() // conditional claim, not unconditional set
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 })
    expect((await claimAtsRun('u1', 'j1')).claimed).toBe(false)
  })

  it('a stale (>3min) marker is reclaimable via the same conditional', async () => {
    reset()
    mockAppUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 })
    const now = new Date('2026-07-14T12:00:00Z')
    await claimAtsRun('u1', 'j1', now)
    const [filter] = mockAppUpdateOne.mock.calls[0]
    expect(filter.$or[1].atsRequestedAt.$lt).toEqual(new Date('2026-07-14T11:57:00Z'))
  })
})

describe('transitionStatus (user claims — loose machine, §2)', () => {
  it('applied sets appliedAt + a user-source history entry, and reports the FROM status', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValueOnce({ status: 'apply_clicked' })
    const r = await transitionStatus('u1', 'j1', 'applied', undefined, NOW)
    expect(r).toEqual({ ok: true, status: 'applied', from: 'apply_clicked' })
    const [, update] = mockAppFindOneAndUpdate.mock.calls[0]
    expect(update.$set).toEqual({ status: 'applied', appliedAt: NOW })
    expect(update.$push.statusHistory).toMatchObject({ status: 'applied', source: 'user' })
  })

  it('backward corrections and recoveries are allowed; machine-only apply_clicked is not settable', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValue({ status: 'applied' })
    expect((await transitionStatus('u1', 'j1', 'saved', NOW)).ok).toBe(true) // backward correction
    expect((await transitionStatus('u1', 'j1', 'ghosted', undefined, NOW)).ok).toBe(true)
    expect((await transitionStatus('u1', 'j1', 'apply_clicked' as never, undefined, NOW)).ok).toBe(false)
    expect((await transitionStatus('u1', 'j1', 'nonsense' as never, undefined, NOW)).ok).toBe(false)
  })

  it('no application row → ok:false (route 404s)', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValueOnce(null)
    expect((await transitionStatus('u1', 'j1', 'applied', undefined, NOW)).ok).toBe(false)
  })

  it('emits transition telemetry through the fenced user-event helper', async () => {
    reset()
    mockAppFindOneAndUpdate.mockResolvedValueOnce({ status: 'apply_clicked' })

    expect(await transitionStatus('u1', 'j1', 'applied', { channel: 'web' }, NOW)).toEqual({
      ok: true,
      status: 'applied',
      from: 'apply_clicked',
    })
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs.apply_confirmed',
      userId: 'u1',
      jobPostingId: 'j1',
      props: expect.objectContaining({ from: 'apply_clicked', channel: 'web' }),
    }))
  })

  it('does not update or emit when account deletion wins the transition fence', async () => {
    reset()
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    expect(await transitionStatus('u1', 'j1', 'applied', { channel: 'web' }, NOW)).toEqual({ ok: false })
    expect(mockAppFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})

describe('reportBrokenLink (§4b crowd healing)', () => {
  function appQuery(value: unknown) {
    return { select: () => ({ lean: () => Promise.resolve(value) }) }
  }

  it('rejects missing/cross-user rows and options this user never clicked', async () => {
    reset()
    mockAppFindOne.mockReturnValue(appQuery(null))
    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({ ok: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()

    reset()
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'other-users-shape-is-invisible-to-owner-query',
      clickedApplyOptionIds: [],
      brokenLinkReports: [],
    }))
    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({ ok: false })
    expect(mockAppFindOne).toHaveBeenCalledWith(
      { userId: 'u1', jobPostingId: 'j1' },
      undefined,
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('records the canonical report and increments exactly its source/url/tier rung', async () => {
    reset()
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1',
      clickedApplyOptionIds: [APPLY_OPTION_ID],
      brokenLinkReports: [],
    }))
    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({
      ok: true,
      recorded: true,
      optionId: APPLY_OPTION_ID,
      tier: 'direct-ats',
      hadFailover: false,
    })
    const [appFilter, appUpdate] = mockAppUpdateOne.mock.calls[0]
    expect(appFilter).toMatchObject({
      _id: 'app1',
      userId: 'u1',
      jobPostingId: 'j1',
      clickedApplyOptionIds: APPLY_OPTION_ID,
      'brokenLinkReports.optionId': { $ne: APPLY_OPTION_ID },
    })
    expect(appUpdate.$set.brokenLinkReports).toEqual([{
      optionId: APPLY_OPTION_ID,
      url: APPLY_SOURCE.applyUrl,
      tier: 'direct-ats',
      reportedAt: NOW,
    }])
    const [postFilter, postUpdate, postOpts] = mockPostingUpdateOne.mock.calls[0]
    expect(postFilter).toMatchObject({
      _id: 'j1',
      status: 'open',
      closedReason: { $exists: false },
      provenance: { $elemMatch: {
        sourceKey: APPLY_SOURCE.sourceKey,
        applyUrl: APPLY_SOURCE.applyUrl,
        applyTier: APPLY_SOURCE.applyTier,
      } },
    })
    expect(postUpdate).toEqual({ $inc: { 'provenance.$[elem].brokenReportCount': 1 } })
    expect(postOpts).toMatchObject({
      arrayFilters: [{
        'elem.sourceKey': APPLY_SOURCE.sourceKey,
        'elem.applyUrl': APPLY_SOURCE.applyUrl,
        'elem.applyTier': APPLY_SOURCE.applyTier,
      }],
      session: expect.anything(),
    })
  })

  it('is idempotent per user+option and does not increment a duplicate report', async () => {
    reset()
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1',
      clickedApplyOptionIds: [APPLY_OPTION_ID],
      brokenLinkReports: [{
        optionId: APPLY_OPTION_ID,
        url: APPLY_SOURCE.applyUrl,
        tier: APPLY_SOURCE.applyTier,
        reportedAt: NOW,
      }],
    }))

    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toMatchObject({
      ok: true,
      recorded: false,
    })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects an alternate until that exact current option has been clicked', async () => {
    const alternate = {
      sourceId: 'greenhouse',
      sourceKey: 'greenhouse:2',
      applyUrl: 'https://boards.example/jobs/2',
      applyTier: 'employer' as const,
    }
    const alternateId = applyOptionIdOf({
      sourceKey: alternate.sourceKey,
      url: alternate.applyUrl,
      tier: alternate.applyTier,
    })
    const posting = { title: 'SDE', company: 'X', locations: [], provenance: [APPLY_SOURCE, alternate], status: 'open' }
    reset(posting)
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1', clickedApplyOptionIds: [APPLY_OPTION_ID], brokenLinkReports: [],
    }))
    expect(await reportBrokenLink('u1', 'j1', alternateId, NOW)).toEqual({ ok: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()

    reset(posting)
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1', clickedApplyOptionIds: [APPLY_OPTION_ID, alternateId], brokenLinkReports: [],
    }))
    expect(await reportBrokenLink('u1', 'j1', alternateId, NOW)).toMatchObject({
      ok: true,
      recorded: true,
      tier: 'employer',
      hadFailover: true,
    })
  })

  it('rejects stale/replaced options and restricted closures before application mutation', async () => {
    reset({
      title: 'SDE', company: 'X', locations: [],
      provenance: [{ ...APPLY_SOURCE, applyUrl: 'https://x.example/new' }],
      status: 'open',
    })
    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({ ok: false })
    expect(mockAppFindOne).not.toHaveBeenCalled()

    reset({
      title: 'SDE', company: 'X', locations: [], provenance: [APPLY_SOURCE],
      status: 'closed', closedReason: 'source-revoked',
    })
    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toEqual({ ok: false })
    expect(mockAppFindOne).not.toHaveBeenCalled()
  })

  it('turns a concurrent application-edge loss into an idempotent retry without a second increment', async () => {
    reset()
    mockAppFindOne
      .mockReturnValueOnce(appQuery({
        _id: 'app1', clickedApplyOptionIds: [APPLY_OPTION_ID], brokenLinkReports: [],
      }))
      .mockReturnValueOnce(appQuery({
        _id: 'app1', clickedApplyOptionIds: [APPLY_OPTION_ID],
        brokenLinkReports: [{ optionId: APPLY_OPTION_ID, url: APPLY_SOURCE.applyUrl, reportedAt: NOW }],
      }))
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })

    expect(await reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).toMatchObject({
      ok: true,
      recorded: false,
    })
    expect(mockStartSession).toHaveBeenCalledTimes(2)
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
  })

  it('returns not-found when deletion wins between a broken-link race and its retry', async () => {
    reset()
    mockAppFindOne.mockReturnValueOnce(appQuery({
      _id: 'app1', clickedApplyOptionIds: [APPLY_OPTION_ID], brokenLinkReports: [],
    }))
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
    mockWithActiveJobsAccountWrite
      .mockImplementationOnce(async (_userId: string, work: (session: unknown) => Promise<unknown>) => work({ id: 'first' }))
      .mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    await expect(reportBrokenLink('u1', 'j1', APPLY_OPTION_ID, NOW)).resolves.toEqual({ ok: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
  })

  it('bounds report history while retaining every report for a current provenance option', async () => {
    const provenance = Array.from({ length: 8 }, (_, index) => ({
      sourceId: `source-${index}`,
      sourceKey: `source:${index}`,
      applyUrl: `https://example.com/apply/${index}`,
      applyTier: 'employer' as const,
    }))
    const optionIds = provenance.map((entry) => applyOptionIdOf({
      sourceKey: entry.sourceKey,
      url: entry.applyUrl,
      tier: entry.applyTier,
    }))
    reset({ title: 'SDE', company: 'X', locations: [], provenance, status: 'open' })
    const currentReports = provenance.slice(0, 7).map((entry, index) => ({
      optionId: optionIds[index],
      url: entry.applyUrl,
      tier: entry.applyTier,
      reportedAt: new Date(NOW.getTime() - index - 1),
    }))
    const historical = Array.from({ length: 30 }, (_, index) => ({
      optionId: `legacy-${index}`,
      url: `https://legacy.example/${index}`,
      reportedAt: new Date(NOW.getTime() - 100 - index),
    }))
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1',
      clickedApplyOptionIds: [optionIds[7]],
      brokenLinkReports: [...historical, ...currentReports],
    }))

    expect(await reportBrokenLink('u1', 'j1', optionIds[7], NOW)).toMatchObject({ ok: true, recorded: true })
    const reports = mockAppUpdateOne.mock.calls[0][1].$set.brokenLinkReports
    expect(reports).toHaveLength(16)
    for (const optionId of optionIds) {
      expect(reports.some((report: { optionId?: string }) => report.optionId === optionId)).toBe(true)
    }
  })
})

describe('recordPracticeEvidence (Wave 4.3 — the evidence ticker source)', () => {
  const PRACTICE_JOB_ID = '507f1f77bcf86cd799439011'
  const MISSING_JOB_ID = '507f1f77bcf86cd799439099'

  function appQuery(doc: unknown) {
    return { select: () => ({ lean: () => Promise.resolve(doc) }) }
  }
  function scoredSession(doc: Record<string, unknown>) {
    const session = {
      jobDescription: PRACTICE_JD,
      status: 'completed',
      feedback: { overall_score: 78 },
      config: { interviewType: 'behavioral' },
      evaluations: [
        { status: 'ok', answer: 'A scored answer' },
        { status: 'ok', answer: 'A second scored answer' },
        { status: 'ok', answer: 'A third scored answer' },
      ],
      ...doc,
    }
    if (session.attribution && typeof session.attribution === 'object') {
      session.attribution = {
        handoffVersion: 1,
        jdHash: PRACTICE_JD_HASH,
        ...(session.attribution as Record<string, unknown>),
      }
    }
    return session
  }
  function sessionQuery(doc: unknown) {
    return { select: () => ({ lean: () => Promise.resolve(doc) }) }
  }
  function sessionChain(doc: unknown) {
    const persisted = doc && typeof doc === 'object'
      ? scoredSession(doc as Record<string, unknown>)
      : doc
    mockSessionFindOne.mockReturnValue(sessionQuery(persisted))
  }

  it('uses the real type-aware completed-feedback gate', () => {
    const standard = scoredSession({})
    expect(hasCompletedScoredPractice(standard)).toBe(true)
    expect(hasCompletedScoredPractice({ ...standard, status: 'in_progress' })).toBe(false)
    expect(hasCompletedScoredPractice({ ...standard, evaluations: standard.evaluations.slice(0, 2) })).toBe(false)
    expect(hasCompletedScoredPractice({ ...standard, feedback: undefined })).toBe(false)
    expect(hasCompletedScoredPractice({
      ...standard,
      config: { interviewType: 'coding' },
      evaluations: standard.evaluations.slice(0, 1),
    })).toBe(true)
    expect(hasCompletedScoredPractice({
      ...standard,
      config: { interviewType: 'system-design' },
      evaluations: standard.evaluations.slice(0, 1),
    })).toBe(true)
  })

  it('rejects completed rows that lack a server-verified Jobs handoff marker', async () => {
    reset()
    mockSessionFindOne.mockReturnValue(sessionQuery({
      ...scoredSession({ _id: 's1', userId: 'u1' }),
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
    }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockIsJobsAccountActive).not.toHaveBeenCalled()
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('existing canonical row gains evidence without mutating status/history; count is capped at 3', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID, applicationId: 'app1' } })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery({ _id: 'app1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['a', 'b', 'c', 'd'] }))

    const r = await recordPracticeEvidence('u1', 's1')
    expect(r).toEqual({ recorded: true, evidenceCount: 3 })
    const [filter, update] = mockAppUpdateOne.mock.calls[0]
    expect(filter).toEqual({
      userId: 'u1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: { $ne: 's1' },
    }) // canonical ownership + job binding; predicate proves insertion
    expect(update.$addToSet).toEqual({ practiceSessionIds: 's1', verifiedPracticeSessionIds: 's1' })
    expect(update.$setOnInsert).toBeUndefined() // destination validators never see create-only snapshot fields
    expect(update.$set).toBeUndefined()
    expect(update.$push).toBeUndefined()
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-s1',
      name: 'jobs/evidence.attribute',
      data: { sessionId: 's1', applicationId: 'app1', jobPostingId: PRACTICE_JOB_ID },
    })
    expect(mockSessionUpdateOne).not.toHaveBeenCalled() // already canonical
  })

  it('no applicationId still resolves the canonical row and repairs persisted attribution', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app9',
      jobPostingId: PRACTICE_JOB_ID,
      practiceSessionIds: ['legacy-a', 'legacy-b', 's1'],
      verifiedPracticeSessionIds: ['s1'],
    }))

    const r = await recordPracticeEvidence('u1', 's1')
    expect(r).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockAppUpdateOne.mock.calls[0][0]).toEqual({
      userId: 'u1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: { $ne: 's1' },
    })
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 's1', userId: 'u1', 'attribution.source': 'jobs', 'attribution.jobId': PRACTICE_JOB_ID },
      { $set: { 'attribution.applicationId': 'app9' } },
      expect.objectContaining({ session: expect.anything() }),
    )
  })

  it('non-jobs and non-owned sessions record nothing', async () => {
    reset()
    sessionChain({ _id: 's2', userId: 'u1', attribution: undefined })
    expect(await recordPracticeEvidence('u1', 's2')).toEqual({ recorded: false })
    sessionChain(null) // owner-scoped query does not return another user's row
    expect(await recordPracticeEvidence('u1', 's3')).toEqual({ recorded: false })
    expect(mockSessionFindOne).toHaveBeenLastCalledWith({ _id: 's3', userId: 'u1' })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('practice-first atomically auto-saves the job and records evidence in one upsert', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 })
    mockAppFindOne
      .mockReturnValueOnce(appQuery(null))
      .mockReturnValue(appQuery({ _id: 'app-new', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })

    const upsertCall = mockAppUpdateOne.mock.calls.find((call) => call[2]?.upsert)
    expect(upsertCall).toBeDefined()
    const [filter, update, options] = upsertCall!
    expect(filter).toEqual({
      userId: 'u1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: { $ne: 's1' },
    })
    expect(update.$addToSet).toEqual({ practiceSessionIds: 's1', verifiedPracticeSessionIds: 's1' })
    expect(update.$setOnInsert).toMatchObject({
      jobSnapshot: { title: 'SDE', company: 'PhonePe', location: 'Pune', source: 'jsearch' },
      status: 'saved',
      statusHistory: [{ status: 'saved', source: 'system' }],
    })
    expect(update.$setOnInsert.statusHistory[0].at).toBeInstanceOf(Date)
    expect(options).toMatchObject({ upsert: true, setDefaultsOnInsert: true, runValidators: true })
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: PRACTICE_JOB_ID,
        status: 'open',
        closedReason: { $exists: false },
        jdCompressed: PRACTICE_JD_COMPRESSED,
      },
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      expect.objectContaining({ session: expect.anything(), timestamps: false }),
    )
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-s1',
      name: 'jobs/evidence.attribute',
      data: { sessionId: 's1', applicationId: 'app-new', jobPostingId: PRACTICE_JOB_ID },
    })
  })

  it('a stale applicationId cannot misattribute evidence; it falls back to the canonical user+job row', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID, applicationId: 'stale-app' } })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery({ _id: 'canonical-app', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockAppUpdateOne.mock.calls[0][0]).toEqual({
      userId: 'u1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: { $ne: 's1' },
    })
    expect(mockInngestSend.mock.calls[0][0].data.applicationId).toBe('canonical-app')
    expect(mockSessionUpdateOne.mock.calls[0][1]).toEqual({ $set: { 'attribution.applicationId': 'canonical-app' } })
  })

  it('an idempotent retry returns the durable count without emitting or charging again', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID, applicationId: 'app1' } })
    // Even if timestamp middleware reports modifiedCount:1, the conditional
    // predicate matched no row, so this caller is not the insertion winner.
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery({ _id: 'app1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('keeps the insertion predicate under real Mongoose timestamp middleware', async () => {
    type CollectionUpdateOne = typeof RealJobApplication.collection.updateOne
    const original = RealJobApplication.collection.updateOne
    let observedFilter: Record<string, unknown> | undefined
    let observedUpdate: Record<string, unknown> | undefined
    RealJobApplication.collection.updateOne = (async (filter, update) => {
      observedFilter = filter as unknown as Record<string, unknown>
      observedUpdate = update as unknown as Record<string, unknown>
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
    }) as CollectionUpdateOne

    try {
      await RealJobApplication.updateOne(
        {
          userId: '507f1f77bcf86cd799439010',
          jobPostingId: PRACTICE_JOB_ID,
          verifiedPracticeSessionIds: { $ne: '507f1f77bcf86cd799439012' },
        },
        {
          $addToSet: {
            practiceSessionIds: '507f1f77bcf86cd799439012',
            verifiedPracticeSessionIds: '507f1f77bcf86cd799439012',
          },
        }
      )
    } finally {
      RealJobApplication.collection.updateOne = original
    }

    expect(String((observedFilter?.verifiedPracticeSessionIds as { $ne: unknown }).$ne)).toBe('507f1f77bcf86cd799439012')
    expect(observedUpdate?.$set).toMatchObject({ updatedAt: expect.any(Date) })
    expect(String((observedUpdate?.$addToSet as { verifiedPracticeSessionIds: unknown }).verifiedPracticeSessionIds)).toBe(
      '507f1f77bcf86cd799439012'
    )
  })

  it('a duplicate-key upsert race retries the idempotent evidence attach on the winning row', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne
      .mockReturnValueOnce(appQuery(null))
      .mockReturnValue(appQuery({ _id: 'winner', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockAppUpdateOne).toHaveBeenCalledTimes(3)
    expect(mockAppUpdateOne.mock.calls[2][0]).toEqual({
      userId: 'u1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: { $ne: 's1' },
    })
    expect(mockAppUpdateOne.mock.calls[2][1]).toEqual({
      $addToSet: { practiceSessionIds: 's1', verifiedPracticeSessionIds: 's1' },
    })
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
  })

  it('missing posting cannot fabricate a tracker snapshot', async () => {
    reset(null)
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: MISSING_JOB_ID } })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery(null))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('missing posting fails closed even when a browser id names an existing application', async () => {
    reset(null)
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: MISSING_JOB_ID } })
    mockAppFindOne.mockReturnValue(appQuery({ _id: 'existing-app', jobPostingId: MISSING_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('a source-revoked posting cannot be pinned, materialized, or enqueued by practice reconciliation', async () => {
    reset({
      title: 'SDE',
      company: 'PhonePe',
      locations: ['Pune'],
      provenance: [{ sourceId: 'jsearch' }],
      status: 'closed',
      closedReason: 'source-revoked',
      jdCompressed: PRACTICE_JD_COMPRESSED,
    })
    sessionChain({
      _id: 's1',
      userId: 'u1',
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
    })

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('preserves verified practice evidence for a normal retained archive', async () => {
    reset({
      title: 'SDE',
      company: 'PhonePe',
      locations: ['Pune'],
      provenance: [{ sourceId: 'jsearch' }],
      status: 'closed',
      closedReason: 'aged-out',
      jdCompressed: PRACTICE_JD_COMPRESSED,
    })
    sessionChain({
      _id: 's1',
      userId: 'u1',
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID, applicationId: 'app1' },
    })
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1',
      jobPostingId: PRACTICE_JOB_ID,
      verifiedPracticeSessionIds: ['s1'],
    }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: PRACTICE_JOB_ID,
        status: 'closed',
        closedReason: 'aged-out',
        jdCompressed: PRACTICE_JD_COMPRESSED,
      },
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      expect.objectContaining({ session: expect.anything(), timestamps: false }),
    )
    expect(mockInngestSend).toHaveBeenCalledOnce()
  })

  it('removes only the session relationship and retains the tracker row when source revocation wins', async () => {
    reset()
    sessionChain({
      _id: 's1',
      userId: 'u1',
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
    })
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })
    mockAppFindOne
      .mockReturnValueOnce(appQuery(null))
      .mockReturnValue(appQuery({
        _id: 'auto-app',
        jobPostingId: PRACTICE_JOB_ID,
        verifiedPracticeSessionIds: ['s1'],
      }))
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    // Save is a no-op when this row already exists, so cleanup cannot infer
    // that a system-looking snapshot has no concurrent user ownership intent.
    expect(mockAppUpdateOne).toHaveBeenLastCalledWith(
      {
        _id: 'auto-app',
        userId: 'u1',
        jobPostingId: PRACTICE_JOB_ID,
        verifiedPracticeSessionIds: 's1',
      },
      { $pull: { practiceSessionIds: 's1', verifiedPracticeSessionIds: 's1' } },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mockAppDeleteOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('malformed job attribution is rejected before any database write or event', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: 'not-an-object-id' } })

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('failed/truncated-only evaluations cannot materialize a tracker row', async () => {
    reset()
    sessionChain({
      _id: 's1',
      userId: 'u1',
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
      evaluations: [
        { status: 'failed', answer: 'not scored' },
        { status: 'truncated', answer: 'not scored either' },
      ],
    })

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockIsJobsAccountActive).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('server-side JD binding rejects a valid but cross-job browser jobId before mutation', async () => {
    reset()
    sessionChain({
      _id: 's1',
      userId: 'u1',
      jobDescription: 'A completely different role and description',
      attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
    })

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('normalizes unbounded posting fields to the application snapshot schema limits', async () => {
    reset({
      title: 'SDE',
      company: 'PhonePe',
      locations: ['L'.repeat(250)],
      provenance: [{ sourceId: 'S'.repeat(150) }],
      status: 'open',
      jdCompressed: PRACTICE_JD_COMPRESSED,
    })
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 })
    mockAppFindOne
      .mockReturnValueOnce(appQuery(null))
      .mockReturnValue(appQuery({ _id: 'app-new', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
    const upsert = mockAppUpdateOne.mock.calls.find((call) => call[2]?.upsert)
    const setOnInsert = upsert?.[1].$setOnInsert
    expect(setOnInsert.jobSnapshot.location).toHaveLength(200)
    expect(setOnInsert.jobSnapshot.source).toHaveLength(100)
    const validationError = new RealJobApplication({
      userId: '507f1f77bcf86cd799439010',
      jobPostingId: PRACTICE_JOB_ID,
      ...setOnInsert,
      practiceSessionIds: ['507f1f77bcf86cd799439012'],
      verifiedPracticeSessionIds: ['507f1f77bcf86cd799439012'],
    }).validateSync()
    expect(validationError).toBeUndefined()
  })

  it('does not pin, materialize, or enqueue when account deletion wins the write fence', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockAppDeleteOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('pulls the evidence reference when the session is deleted during materialization', async () => {
    reset()
    const firstRead = scoredSession({
      _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID },
    })
    mockSessionFindOne
      .mockReturnValueOnce(sessionQuery(firstRead))
      .mockReturnValueOnce(sessionQuery({ _id: 's1' }))
      .mockReturnValueOnce(sessionQuery(null))
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })
    mockAppFindOne.mockReturnValue(appQuery({
      _id: 'app1',
      jobPostingId: PRACTICE_JOB_ID,
      verifiedPracticeSessionIds: ['s1'],
    }))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockAppUpdateOne).toHaveBeenLastCalledWith(
      {
        _id: 'app1',
        userId: 'u1',
        jobPostingId: PRACTICE_JOB_ID,
        verifiedPracticeSessionIds: 's1',
      },
      { $pull: { practiceSessionIds: 's1', verifiedPracticeSessionIds: 's1' } },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('a vanished application after the write returns false and emits nothing', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID } })
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 })
    mockAppFindOne.mockReturnValue(appQuery(null))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: false })
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('an event-send failure does not roll back durable evidence', async () => {
    reset()
    sessionChain({ _id: 's1', userId: 'u1', attribution: { source: 'jobs', jobId: PRACTICE_JOB_ID, applicationId: 'app1' } })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })
    mockAppFindOne.mockReturnValue(appQuery({ _id: 'app1', jobPostingId: PRACTICE_JOB_ID, verifiedPracticeSessionIds: ['s1'] }))
    mockInngestSend.mockRejectedValueOnce(new Error('temporary outage'))

    expect(await recordPracticeEvidence('u1', 's1')).toEqual({ recorded: true, evidenceCount: 1 })
  })
})

describe('saveTailoredVersion (§2 — latest-wins, never a cap seat)', () => {
  const { gzipSync } = require('zlib')
  const TAILOR_JD = 'the jd body'
  const TAILOR_JD_COMPRESSED = gzipSync(Buffer.from(TAILOR_JD))
  const TAILOR_SOURCE_HASH = practiceHandoffHashOf(TAILOR_JD)
  const PAYLOAD = { tailoredText: 'TAILORED', sourceResumeId: 'r1', matchScore: 78, addedKeywords: ['sql'], missingKeywords: ['kafka'], sourceJdHash: TAILOR_SOURCE_HASH }
  const PASTE_PAYLOAD = { tailoredText: 'TAILORED', sourceResumeId: undefined, matchScore: 78, addedKeywords: [], missingKeywords: [], sourceJdHash: TAILOR_SOURCE_HASH }
  function postingChain(doc: unknown, app: unknown = { _id: 'app1' }) {
    mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) })
    mockAppFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(app) }) })
  }

  it('existing row: $set tailoredVersion with jdHash bound to the posting JD', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1 })
    const r = await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const [filter, update, options] = mockAppUpdateOne.mock.calls[0]
    expect(filter).toEqual({ _id: 'app1', userId: 'u1', jobPostingId: 'j1' })
    expect(update.$set.tailoredVersion).toMatchObject({ tailoredText: 'TAILORED', matchScore: 78, createdAt: NOW })
    expect(update.$set.tailoredVersion.jdHash).toHaveLength(20)
    expect(options).toMatchObject({ runValidators: true, session: expect.anything() })
    expect(mockAppCreate).not.toHaveBeenCalled()
  })

  it('enforces the shared text boundary before reading or pinning a posting', async () => {
    reset()
    postingChain({
      title: 'SDE',
      company: 'X',
      locations: [],
      provenance: [],
      status: 'open',
      jdCompressed: TAILOR_JD_COMPRESSED,
    })

    expect(await saveTailoredVersion(
      'u1',
      'j1',
      { ...PAYLOAD, tailoredText: 'x'.repeat(60_000) },
      NOW,
    )).toEqual({ ok: true })

    reset()
    expect(await saveTailoredVersion(
      'u1',
      'j1',
      { ...PAYLOAD, tailoredText: 'x'.repeat(60_001) },
      NOW,
    )).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()

    expect(await saveTailoredVersion(
      'u1',
      'j1',
      { ...PAYLOAD, tailoredText: '   ' },
      NOW,
    )).toEqual({ ok: false, reason: 'invalid-payload' })
    expect(mockPostingFindById).not.toHaveBeenCalled()
  })

  it('no row: implicit save — creates at saved WITH the tailored version and pins the posting', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: ['Pune'], provenance: [{ sourceId: 'jsearch' }], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED }, null)
    const r = await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const created = mockAppCreate.mock.calls[0][0][0]
    expect(created.status).toBe('saved')
    expect(created.tailoredVersion.tailoredText).toBe('TAILORED')
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'j1', status: 'open', jdCompressed: TAILOR_JD_COMPRESSED }),
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      expect.objectContaining({ session: expect.anything(), timestamps: false }),
    )
    expect(mockAppCreate.mock.calls[0][1]).toMatchObject({ session: expect.anything() })
  })

  it('paste-sourced tailors (no sourceResumeId) create cleanly — empty string never reaches Mongoose (Codex P1 #526)', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED }, null)
    const r = await saveTailoredVersion('u1', 'j1', PASTE_PAYLOAD, NOW)
    expect(r).toEqual({ ok: true })
    const created = mockAppCreate.mock.calls[0][0][0]
    expect(created.tailoredVersion.sourceResumeId).toBeUndefined() // absent, not ''
    expect('sourceResumeId' in created.tailoredVersion && created.tailoredVersion.sourceResumeId === '').toBe(false)
  })

  it('updates an existing normal archive but cannot manufacture closed or restricted ownership', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'closed', closedReason: 'aged-out', jdCompressed: TAILOR_JD_COMPRESSED })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1 })
    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: true })

    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'closed', closedReason: 'aged-out', jdCompressed: TAILOR_JD_COMPRESSED }, null)
    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: false, reason: 'not-found' })
    expect(mockAppCreate).not.toHaveBeenCalled()

    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'closed', closedReason: 'source-revoked', jdCompressed: TAILOR_JD_COMPRESSED })
    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: false, reason: 'context-unavailable' })
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('does not implicitly save when closure wins the atomic open-posting pin', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED }, null)
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: false, reason: 'context-unavailable' })
    expect(mockAppCreate).not.toHaveBeenCalled()
  })

  it('rejects an edited or stale JD hash before it can attach an artifact', async () => {
    reset()
    postingChain({ title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED })

    expect(await saveTailoredVersion('u1', 'j1', { ...PAYLOAD, sourceJdHash: practiceHandoffHashOf('edited jd') }, NOW))
      .toEqual({ ok: false, reason: 'jd-mismatch' })
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('missing posting → ok:false; create race falls back to update', async () => {
    reset()
    postingChain(null)
    expect(await saveTailoredVersion('u1', 'gone', PAYLOAD, NOW)).toEqual({ ok: false, reason: 'not-found' })
    reset()
    const posting = { title: 'SDE', company: 'X', locations: [], provenance: [], status: 'open', jdCompressed: TAILOR_JD_COMPRESSED }
    mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(posting) }) })
    mockAppFindOne
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ _id: 'winner' }) }) })
    mockAppUpdateOne.mockResolvedValueOnce({ matchedCount: 1 })
    mockAppCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: true })
    expect(mockStartSession).toHaveBeenCalledTimes(2)
    expect(mockAppUpdateOne).toHaveBeenCalledWith(
      { _id: 'winner', userId: 'u1', jobPostingId: 'j1' },
      expect.objectContaining({ $set: expect.objectContaining({ tailoredVersion: expect.anything() }) }),
      expect.objectContaining({ session: expect.anything(), runValidators: true }),
    )
  })

  it('keeps the exact authority pin and application write in one transaction', async () => {
    reset()
    postingChain({
      title: 'SDE', company: 'X', locations: [], provenance: [],
      status: 'open', jdCompressed: TAILOR_JD_COMPRESSED,
    })

    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: true })

    const transactionSession = await mockStartSession.mock.results[0].value
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'j1',
        status: 'open',
        closedReason: { $exists: false },
        jdCompressed: TAILOR_JD_COMPRESSED,
      },
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      { session: transactionSession, timestamps: false },
    )
    expect(mockAppUpdateOne.mock.calls[0][2]).toMatchObject({
      session: transactionSession,
      runValidators: true,
    })
  })

  it('propagates a non-duplicate application failure so the transaction rolls back its pin', async () => {
    reset()
    postingChain({
      title: 'SDE', company: 'X', locations: [], provenance: [],
      status: 'open', jdCompressed: TAILOR_JD_COMPRESSED,
    }, null)
    mockAppCreate.mockRejectedValueOnce(new Error('validation failed'))

    await expect(saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).rejects.toThrow('validation failed')
    expect(mockPostingUpdateOne).toHaveBeenCalledOnce()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('does not inspect, pin, or persist a tailored artifact for a deleting account', async () => {
    reset()
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    expect(await saveTailoredVersion('u1', 'j1', PAYLOAD, NOW)).toEqual({ ok: false, reason: 'not-found' })
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockAppCreate).not.toHaveBeenCalled()
  })
})
