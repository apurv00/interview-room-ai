import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockPostingFindById, mockPostingUpdateOne,
  mockApplicationFindOne, mockApplicationCreate, mockEventCreate,
  mockCheckJobsRateLimit, mockStartSession, mockWithTransaction, mockEndSession,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockApplicationCreate: vi.fn(),
  mockEventCreate: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockStartSession: vi.fn(),
  mockWithTransaction: vi.fn(),
  mockEndSession: vi.fn(),
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
    db: { startSession: mockStartSession },
  },
  ProductEvent: { create: mockEventCreate },
}))

import { POST } from '../route'

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
  mockEventCreate.mockResolvedValue({})
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockWithTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
  mockStartSession.mockResolvedValue(TRANSACTION_SESSION)
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
  })

  it('pins the exact lifecycle/provenance snapshot and inserts ownership in one transaction', async () => {
    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true, status: 'saved', alreadySaved: false })
    expect(mockWithTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    })
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: JOB_ID,
        status: 'open',
        closedReason: { $exists: false },
        provenance: PROVENANCE,
      },
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
      { session: TRANSACTION_SESSION },
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
    expect(mockEventCreate).toHaveBeenCalledOnce()
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
    expect(mockEventCreate).not.toHaveBeenCalled()
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
        { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
        { session: TRANSACTION_SESSION },
      )
      expect(mockApplicationCreate).not.toHaveBeenCalled()
      expect(mockEventCreate).not.toHaveBeenCalled()
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
    expect(mockEventCreate).not.toHaveBeenCalled()
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
    expect(mockEventCreate).not.toHaveBeenCalled()
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
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
      { session: TRANSACTION_SESSION },
    )
    expect(mockApplicationCreate).toHaveBeenCalledWith(expect.any(Array), { session: TRANSACTION_SESSION })
    expect(mockEventCreate).not.toHaveBeenCalled()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })
})
