import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockTransitionStatus,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockTransitionStatus: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@jobs', () => ({
  transitionStatus: mockTransitionStatus,
  USER_SETTABLE_STATUSES: [
    'saved',
    'applied',
    'interview_scheduled',
    'offer',
    'rejected',
    'ghosted',
    'withdrawn',
  ],
}))

import { POST } from '../route'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'

function request(status = 'applied') {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockConnectDB.mockResolvedValue(undefined)
  mockTransitionStatus.mockResolvedValue({ ok: true, status: 'applied', from: 'saved' })
})

describe('POST /api/jobs/[id]/status account fence', () => {
  it('returns the account-unavailable contract when deletion owns the write fence', async () => {
    mockTransitionStatus.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('keeps an ordinary missing application distinct from an inactive account', async () => {
    mockTransitionStatus.mockResolvedValueOnce({ ok: false })

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'no application for this job' })
  })

  it('does not swallow unexpected service failures', async () => {
    mockTransitionStatus.mockRejectedValueOnce(new Error('database failed'))

    await expect(POST(request(), { params: { id: JOB_ID } })).rejects.toThrow('database failed')
  })
})
