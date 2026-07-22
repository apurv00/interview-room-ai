import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockDateForChoice,
  mockDismissConfirmCard,
  mockGetBaseResume,
  mockGetTracker,
  mockGetServerSession,
  mockIsJobsAccountActive,
  mockRequestJson,
  mockSaveBaseResume,
  mockSaveNotes,
  mockSetInterviewDate,
  mockTransitionStatus,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    mockCheckJobsRateLimit: vi.fn(),
    mockConnectDB: vi.fn(),
    mockDateForChoice: vi.fn(),
    mockDismissConfirmCard: vi.fn(),
    mockGetBaseResume: vi.fn(),
    mockGetTracker: vi.fn(),
    mockGetServerSession: vi.fn(),
    mockIsJobsAccountActive: vi.fn(),
    mockRequestJson: vi.fn(),
    mockSaveBaseResume: vi.fn(),
    mockSaveNotes: vi.fn(),
    mockSetInterviewDate: vi.fn(),
    mockTransitionStatus: vi.fn(),
    MockJobsAccountInactiveError,
  }
})

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
  JobsAccountInactiveError: MockJobsAccountInactiveError,
}))
vi.mock('@jobs', () => ({
  dateForChoice: mockDateForChoice,
  dismissConfirmCard: mockDismissConfirmCard,
  getBaseResume: mockGetBaseResume,
  getTracker: mockGetTracker,
  saveBaseResume: mockSaveBaseResume,
  saveNotes: mockSaveNotes,
  setInterviewDate: mockSetInterviewDate,
  transitionStatus: mockTransitionStatus,
  USER_SETTABLE_STATUSES: ['saved', 'applied', 'interview_scheduled', 'offer', 'rejected'],
}))

import { POST as postInterviewDate } from '../../../app/api/jobs/[id]/interview-date/route'
import { POST as postNudgeDismiss } from '../../../app/api/jobs/[id]/nudge-dismiss/route'
import { POST as postStatus } from '../../../app/api/jobs/[id]/status/route'
import { GET as getBaseResume, POST as postBaseResume } from '../../../app/api/jobs/base-resume/route'
import { GET as getTracker } from '../../../app/api/jobs/tracker/route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const request = {
  json: mockRequestJson,
  headers: new Headers({ 'x-origin-user-id': USER_ID }),
} as unknown as Request

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
    status: 429,
    headers: { 'Retry-After': '60' },
  }))
})

describe('Jobs mutation route rate-limit ordering', () => {
  it.each([
    ['interview date', () => postInterviewDate(request, { params: { id: JOB_ID } })],
    ['nudge dismissal/notes', () => postNudgeDismiss(request, { params: { id: JOB_ID } })],
    ['status transition', () => postStatus(request, { params: { id: JOB_ID } })],
    ['base-resume save', () => postBaseResume(request)],
  ])('blocks %s after authentication but before body or database work', async (_name, invoke) => {
    const response = await invoke()

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockRequestJson).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('does not spend the mutation budget for unauthenticated requests', async () => {
    mockGetServerSession.mockResolvedValue(null)

    const response = await postStatus(request, { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
  })

  it('leaves the read-only base-resume GET outside the mutation budget', async () => {
    mockGetBaseResume.mockResolvedValue(null)

    const response = await getBaseResume()

    expect(response.status).toBe(200)
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
    expect(mockConnectDB).toHaveBeenCalledOnce()
  })
})

describe('Jobs inactive-account HTTP contract', () => {
  beforeEach(() => {
    mockCheckJobsRateLimit.mockResolvedValue(null)
    mockConnectDB.mockResolvedValue(undefined)
    mockDateForChoice.mockReturnValue({ date: null, confidence: 'unknown' })
    mockGetTracker.mockResolvedValue({ groups: [], confirmCard: null })
  })

  async function expectAccountUnavailable(response: Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  }

  it('distinguishes an inactive account from an invalid interview-date domain request', async () => {
    mockRequestJson.mockResolvedValue({ choice: 'not-sure' })
    mockSetInterviewDate.mockRejectedValue(new MockJobsAccountInactiveError())

    await expectAccountUnavailable(await postInterviewDate(request, { params: { id: JOB_ID } }))
  })

  it('preserves the interview-date domain miss for an active account', async () => {
    mockRequestJson.mockResolvedValue({ choice: 'not-sure' })
    mockSetInterviewDate.mockResolvedValue({ ok: false, daysUntil: null })

    const response = await postInterviewDate(request, { params: { id: JOB_ID } })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'no application, or the date looks off',
    })
  })

  it('distinguishes an inactive account from a missing application when saving notes', async () => {
    mockRequestJson.mockResolvedValue({ notes: 'private note' })
    mockSaveNotes.mockRejectedValue(new MockJobsAccountInactiveError())

    await expectAccountUnavailable(await postNudgeDismiss(request, { params: { id: JOB_ID } }))
  })

  it('preserves the missing-application result when saving notes for an active account', async () => {
    mockRequestJson.mockResolvedValue({ notes: 'private note' })
    mockSaveNotes.mockResolvedValue(false)

    const response = await postNudgeDismiss(request, { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'no application' })
  })

  it('distinguishes an inactive account from a successful confirm-card dismissal', async () => {
    mockRequestJson.mockResolvedValue({})
    mockDismissConfirmCard.mockRejectedValue(new MockJobsAccountInactiveError())

    await expectAccountUnavailable(await postNudgeDismiss(request, { params: { id: JOB_ID } }))
  })

  it('rejects a stale JWT before reading the tracker', async () => {
    mockGetTracker.mockRejectedValueOnce(new MockJobsAccountInactiveError())

    await expectAccountUnavailable(await getTracker())
    expect(mockGetTracker).toHaveBeenCalledWith(USER_ID)
    expect(mockIsJobsAccountActive).not.toHaveBeenCalled()
  })

  it('discards a tracker snapshot when deletion begins during the read', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)
    mockGetTracker.mockResolvedValue({
      groups: [{ status: 'saved', count: 1, rows: [{ notes: 'private' }] }],
      confirmCard: null,
    })

    await expectAccountUnavailable(await getTracker())
    expect(mockGetTracker).toHaveBeenCalledWith(USER_ID)
    expect(mockIsJobsAccountActive).toHaveBeenCalledOnce()
  })

  it('returns the tracker only after both active-account checks pass', async () => {
    const tracker = { groups: [], confirmCard: null }
    mockGetTracker.mockResolvedValue(tracker)

    const response = await getTracker()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(tracker)
    expect(mockIsJobsAccountActive).toHaveBeenCalledOnce()
  })
})

describe('Interview-date calendar input', () => {
  beforeEach(() => {
    mockCheckJobsRateLimit.mockResolvedValue(null)
    mockConnectDB.mockResolvedValue(undefined)
    mockSetInterviewDate.mockResolvedValue({ ok: true, daysUntil: 8 })
  })

  it('accepts only a real YYYY-MM-DD calendar date', async () => {
    mockRequestJson.mockResolvedValue({ date: '2026-07-30' })

    const response = await postInterviewDate(request, { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockSetInterviewDate).toHaveBeenCalledWith(
      USER_ID,
      JOB_ID,
      { date: new Date('2026-07-30T00:00:00.000Z'), confidence: 'exact' },
    )
  })

  it.each(['2026-02-31', '2026-07-30T14:00:00.000Z', 'July 30, 2026'])(
    'rejects non-calendar precision: %s',
    async (date) => {
      mockRequestJson.mockResolvedValue({ date })

      const response = await postInterviewDate(request, { params: { id: JOB_ID } })

      expect(response.status).toBe(400)
      expect(mockSetInterviewDate).not.toHaveBeenCalled()
      expect(mockConnectDB).not.toHaveBeenCalled()
    },
  )
})
