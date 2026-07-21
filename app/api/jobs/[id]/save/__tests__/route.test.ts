import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockPostingFindById, mockPostingUpdateOne,
  mockApplicationFindOne, mockApplicationCreate, mockRecordJobsUserEvent,
  mockCheckJobsRateLimit, mockStartSession, mockWithTransaction, mockEndSession,
  mockWithActiveJobsAccountWrite,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockApplicationCreate: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockStartSession: vi.fn(),
  mockWithTransaction: vi.fn(),
  mockEndSession: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne },
  JobApplication: {
    findOne: mockApplicationFindOne,
    create: mockApplicationCreate,
  },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
      this.name = 'JobsAccountInactiveError'
    }
  },
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))
vi.mock('@jobs/services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))

import { POST } from '../route'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const PROVENANCE = [{
  sourceId: 'greenhouse:acme',
  externalId: 'job-1',
  sourceKey: 'greenhouse:acme:job-1',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  applyTier: 'direct-ats',
  firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
  lastSeenAt: new Date('2026-07-20T00:00:00.000Z'),
}]
const LIVE_POSTING = {
  title: 'Backend Engineer',
  company: 'Acme',
  locations: ['Pune'],
  provenance: PROVENANCE,
  status: 'open',
}
const TRANSACTION_SESSION = {
  withTransaction: mockWithTransaction,
  endSession: mockEndSession,
}
const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockResolvedValue(undefined)
  mockPostingFindById.mockReturnValue(selectLean(LIVE_POSTING))
  mockApplicationFindOne.mockReturnValue(selectLean(null))
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockApplicationCreate.mockResolvedValue([])
  mockRecordJobsUserEvent.mockResolvedValue(true)
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockWithTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
  mockStartSession.mockResolvedValue(TRANSACTION_SESSION)
  mockWithActiveJobsAccountWrite.mockImplementation(async (
    _userId: string,
    work: (session: typeof TRANSACTION_SESSION) => Promise<unknown>,
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
})

describe('POST /api/jobs/[id]/save transactional ownership fence', () => {
  it('applies the shared mutation budget before database work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
    expect(mockStartSession).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
  })

  it('pins the exact lifecycle/provenance snapshot and inserts ownership in one transaction', async () => {
    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true, status: 'saved', alreadySaved: false })
    expect(mockWithTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: JOB_ID,
        status: 'open',
        closedReason: { $exists: false },
        provenance: PROVENANCE,
      },
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      { session: TRANSACTION_SESSION, timestamps: false },
    )
    expect(mockApplicationCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        userId: USER_ID,
        jobPostingId: JOB_ID,
        status: 'saved',
        jobSnapshot: expect.objectContaining({ source: 'greenhouse:acme' }),
      })],
      { session: TRANSACTION_SESSION },
    )
    expect(mockRecordJobsUserEvent).toHaveBeenCalledOnce()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['a normal close', { ...LIVE_POSTING, status: 'closed', closedReason: 'aged-out' }],
    ['source revocation', { ...LIVE_POSTING, status: 'closed', closedReason: 'source-revoked' }],
  ])('does not create ownership when %s wins the exact pin race', async (_case, closedPosting) => {
    mockPostingFindById
      .mockReturnValueOnce(selectLean(LIVE_POSTING))
      .mockReturnValueOnce(selectLean(closedPosting))
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockApplicationCreate).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
    expect(mockStartSession).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['live', LIVE_POSTING],
    ['normally archived', { ...LIVE_POSTING, status: 'closed', closedReason: 'aged-out' }],
  ])(
    'keeps an existing owner idempotent and exactly repins a %s posting',
    async (_state, posting) => {
      mockPostingFindById.mockReturnValue(selectLean(posting))
      mockApplicationFindOne.mockReturnValue(selectLean({ status: 'applied' }))

      const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

      expect(await response.json()).toEqual({ ok: true, status: 'applied', alreadySaved: true })
      expect(mockApplicationFindOne).toHaveBeenCalledWith(
        { userId: USER_ID, jobPostingId: JOB_ID },
        undefined,
        { session: TRANSACTION_SESSION },
      )
      expect(mockPostingUpdateOne).toHaveBeenCalledWith(
        {
          _id: JOB_ID,
          status: posting.status,
          closedReason: posting.closedReason ?? { $exists: false },
          provenance: PROVENANCE,
        },
        {
          $set: { userReferenced: true },
          $unset: { purgeAt: 1 },
          $inc: { derivedAuthorityRevision: 1 },
        },
        { session: TRANSACTION_SESSION, timestamps: false },
      )
      expect(mockApplicationCreate).not.toHaveBeenCalled()
      expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
    },
  )

  it('does not repin or expose an existing owner through restricted source authority', async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      ...LIVE_POSTING,
      status: 'closed',
      closedReason: 'source-revoked',
    }))
    mockApplicationFindOne.mockReturnValue(selectLean({ status: 'applied' }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockApplicationCreate).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('turns a duplicate insert race into a truthful idempotent response without telemetry', async () => {
    mockApplicationFindOne
      .mockReturnValueOnce(selectLean(null))
      .mockReturnValueOnce(selectLean({ status: 'offer' }))
    mockApplicationCreate.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true, status: 'offer', alreadySaved: true })
    expect(mockStartSession).toHaveBeenCalledTimes(2)
    expect(mockPostingUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockApplicationCreate).toHaveBeenCalledOnce()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns account unavailable when deletion wins between a duplicate race and its retry', async () => {
    mockApplicationCreate.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
    let fenceCalls = 0
    mockWithActiveJobsAccountWrite.mockImplementation(async (
      _userId: string,
      work: (session: typeof TRANSACTION_SESSION) => Promise<unknown>,
    ) => {
      fenceCalls += 1
      if (fenceCalls === 2) throw new JobsAccountInactiveError(USER_ID)
      return work(TRANSACTION_SESSION)
    })

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockApplicationCreate).toHaveBeenCalledOnce()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('lets a non-duplicate insert failure abort the pin and emits no telemetry', async () => {
    const storeError = new Error('write failed')
    let transactionAborted = false
    mockApplicationCreate.mockRejectedValueOnce(storeError)
    mockWithTransaction.mockImplementationOnce(async (work: () => Promise<unknown>) => {
      try {
        return await work()
      } catch (error) {
        transactionAborted = true
        throw error
      }
    })

    await expect(POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )).rejects.toBe(storeError)

    expect(transactionAborted).toBe(true)
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: JOB_ID, provenance: PROVENANCE }),
      {
        $set: { userReferenced: true },
        $unset: { purgeAt: 1 },
        $inc: { derivedAuthorityRevision: 1 },
      },
      { session: TRANSACTION_SESSION, timestamps: false },
    )
    expect(mockApplicationCreate).toHaveBeenCalledWith(expect.any(Array), { session: TRANSACTION_SESSION })
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('returns account unavailable when deletion owns the fence and creates no pin, row, or event', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockApplicationCreate).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})
