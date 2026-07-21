import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockDateForChoice,
  mockDismissConfirmCard,
  mockGetBaseResume,
  mockGetServerSession,
  mockIsJobsAccountActive,
  mockRequestJson,
  mockSaveBaseResume,
  mockSaveNotes,
  mockSetInterviewDate,
  mockTransitionStatus,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockDateForChoice: vi.fn(),
  mockDismissConfirmCard: vi.fn(),
  mockGetBaseResume: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockRequestJson: vi.fn(),
  mockSaveBaseResume: vi.fn(),
  mockSaveNotes: vi.fn(),
  mockSetInterviewDate: vi.fn(),
  mockTransitionStatus: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({ isJobsAccountActive: mockIsJobsAccountActive }))
vi.mock('@jobs', () => ({
  dateForChoice: mockDateForChoice,
  dismissConfirmCard: mockDismissConfirmCard,
  getBaseResume: mockGetBaseResume,
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

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const request = { json: mockRequestJson } as unknown as Request

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
