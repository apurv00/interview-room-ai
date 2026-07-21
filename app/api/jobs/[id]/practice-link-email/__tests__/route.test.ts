import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockGetConfig, mockApplicationExists,
  mockPostingFindById, mockUserFindById, mockInngestSend,
  mockPreparePractice,
  mockCheckJobsRateLimit,
  mockIsJobsAccountActive, mockRecordJobsUserEvent,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetConfig: vi.fn(),
  mockApplicationExists: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockUserFindById: vi.fn(),
  mockInngestSend: vi.fn(),
  mockPreparePractice: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mockInngestSend } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({ isJobsAccountActive: mockIsJobsAccountActive }))
vi.mock('@jobs/services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))
vi.mock('@shared/db/models', () => ({
  JobsEmailConfig: { getConfig: mockGetConfig },
  JobApplication: { exists: mockApplicationExists },
  JobPosting: { findById: mockPostingFindById },
  User: { findById: mockUserFindById },
}))
vi.mock('@jobs', () => ({
  isSuppressed: () => false,
  jobPostingStateOf: (posting: { status: string; closedReason?: string }) => (
    posting.status === 'open'
      ? 'live'
      : posting.closedReason === 'aged-out'
        ? 'archived'
        : 'restricted'
  ),
  preparePracticeHandoffPosting: mockPreparePractice,
}))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockResolvedValue(undefined)
  mockGetConfig.mockResolvedValue({ e0Enabled: true })
  mockApplicationExists.mockResolvedValue({ _id: 'app1' })
  mockPostingFindById.mockReturnValue(selectLean({ status: 'closed', closedReason: 'aged-out' }))
  mockUserFindById.mockReturnValue(selectLean({ emailPreferences: { jobs: { unsubscribedStreams: [] } } }))
  mockInngestSend.mockResolvedValue(undefined)
  mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash', role: 'backend' })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockRecordJobsUserEvent.mockResolvedValue(true)
})

describe('POST /api/jobs/[id]/practice-link-email archive policy', () => {
  it('applies the email budget before database and delivery work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '3600' },
    }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('3600')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID, 'practice-email')
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('keeps deferred Practice available for a normal archive owner', async () => {
    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true })
    expect(mockInngestSend).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs/email.requested', data: expect.objectContaining({ userId: USER_ID, jobPostingId: JOB_ID }),
    }))
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs.prep_deferred_email', userId: USER_ID, jobPostingId: JOB_ID,
    }))
  })

  it('returns the canonical account-unavailable contract before reading private state', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('returns account unavailable when deletion removes ownership during private reads', async () => {
    mockApplicationExists.mockResolvedValue(null)
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockPreparePractice).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('declines restricted closures without scheduling a dead promise', async () => {
    mockPostingFindById.mockReturnValue(selectLean({ status: 'closed', closedReason: 'source-revoked' }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('requires the caller-owned application before scheduling', async () => {
    mockApplicationExists.mockResolvedValue(null)

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('declines when the retained JD or active CMS role cannot support Practice', async () => {
    mockPreparePractice.mockResolvedValue({ jobDescription: 'JD', jdHash: 'hash' })

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: false, reason: 'unavailable' })
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('does not enqueue when account deletion lands during asynchronous Practice preparation', async () => {
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      new Request(`http://localhost/api/jobs/${JOB_ID}/practice-link-email`, { method: 'POST' }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockPreparePractice).toHaveBeenCalledOnce()
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(3)
    expect(mockInngestSend).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})
