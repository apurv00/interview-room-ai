import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockApplicationFindOne, mockPostingFindById,
  mockGetBaseResume, mockClaimAtsRun, mockReleaseAtsClaim, mockPreparePractice, mockInngestSend,
  mockCheckJobsRateLimit, mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockGetBaseResume: vi.fn(),
  mockClaimAtsRun: vi.fn(),
  mockReleaseAtsClaim: vi.fn(),
  mockPreparePractice: vi.fn(),
  mockInngestSend: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mockInngestSend } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
}))
vi.mock('@shared/db/models', () => ({
  JobApplication: { findOne: mockApplicationFindOne },
  JobPosting: { findById: mockPostingFindById },
}))
vi.mock('@jobs', () => ({
  getBaseResume: mockGetBaseResume,
  claimAtsRun: mockClaimAtsRun,
  releaseAtsClaim: mockReleaseAtsClaim,
  preparePracticeHandoffPosting: mockPreparePractice,
  jobPostingStateOf: (posting: { status: string; closedReason?: string }) => (
    posting.status === 'open'
      ? 'live'
      : posting.closedReason === 'aged-out'
        ? 'archived'
        : 'restricted'
  ),
}))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockResolvedValue(undefined)
  mockApplicationFindOne.mockReturnValue(selectLean({ _id: 'app1' }))
  mockPostingFindById.mockReturnValue(selectLean({ status: 'open' }))
  mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash' })
  mockGetBaseResume.mockResolvedValue({ id: 'resume1' })
  mockClaimAtsRun.mockResolvedValue({ claimed: true, claimedAt: new Date('2026-07-20T12:00:00.000Z') })
  mockReleaseAtsClaim.mockResolvedValue(undefined)
  mockInngestSend.mockResolvedValue(undefined)
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('POST /api/jobs/[id]/ats-check lifecycle authorization', () => {
  it('rejects an inactive stale-JWT account before application or posting reads', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockApplicationFindOne).not.toHaveBeenCalled()
    expect(mockPostingFindById).not.toHaveBeenCalled()
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('applies the ATS budget after authentication and before database work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID, 'ats-check')
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('queues a live or normally archived owner check with a canonical JD', async () => {
    let response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }), { params: { id: JOB_ID } })
    expect(response.status).toBe(200)

    mockPostingFindById.mockReturnValue(selectLean({ status: 'closed', closedReason: 'aged-out' }))
    response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }), { params: { id: JOB_ID } })
    expect(response.status).toBe(200)
    expect(mockInngestSend).toHaveBeenCalledTimes(2)
  })

  it('returns account unavailable when deletion removes the application during private reads', async () => {
    mockApplicationFindOne.mockReturnValue(selectLean(null))
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockPreparePractice).not.toHaveBeenCalled()
    expect(mockGetBaseResume).not.toHaveBeenCalled()
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
  })

  it('returns account unavailable when deletion lands during canonical JD preparation', async () => {
    mockPreparePractice.mockResolvedValue({ jobDescription: 'display-only body' })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockGetBaseResume).not.toHaveBeenCalled()
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
  })

  it('returns account unavailable when deletion removes the base resume during its read', async () => {
    mockGetBaseResume.mockResolvedValue(null)
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('returns account unavailable instead of pending when a failed claim races deletion', async () => {
    mockClaimAtsRun.mockResolvedValue({
      claimed: false,
      claimedAt: new Date('2026-07-20T12:00:00.000Z'),
    })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockClaimAtsRun).toHaveBeenCalledWith(USER_ID, JOB_ID)
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(5)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('preserves the active-account pending response for a legitimate competing claim', async () => {
    mockClaimAtsRun.mockResolvedValue({
      claimed: false,
      claimedAt: new Date('2026-07-20T12:00:00.000Z'),
    })

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'pending' })
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(5)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('rejects restricted lifecycle before claiming or enqueueing', async () => {
    mockPostingFindById.mockReturnValue(selectLean({ status: 'closed', closedReason: 'source-revoked' }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ reason: 'posting-unavailable' })
    expect(mockPreparePractice).not.toHaveBeenCalled()
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('rejects missing, corrupt, or oversized canonical JD readiness before enqueueing', async () => {
    mockPreparePractice.mockResolvedValue({ jobDescription: 'display-only body' })

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/ats-check`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ reason: 'posting-unavailable' })
    expect(mockClaimAtsRun).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })
})
