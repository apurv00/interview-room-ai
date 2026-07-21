import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  isJobsAccountActive: vi.fn(),
  listSessions: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))
vi.mock('@interview/services/core/interviewService', () => ({
  listSessions: mocks.listSessions,
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({
    user: {
      id: USER_ID,
      role: 'recruiter',
      organizationId: '507f1f77bcf86cd799439022',
    },
  })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.listSessions.mockResolvedValue({ sessions: [] })
})

describe('GET /api/interviews/last-config', () => {
  it('rejects an inactive account before loading retained setup data', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await GET(new NextRequest('http://localhost/api/interviews/last-config'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })

  it('forces recruiter/admin callers onto the owner-only history contract', async () => {
    await GET(new NextRequest('http://localhost/api/interviews/last-config'))

    expect(mocks.listSessions).toHaveBeenCalledWith({
      userId: USER_ID,
      role: 'candidate',
      page: 1,
      limit: 1,
    })
  })

  it('withholds captured JD and resume text when deletion wins the final check', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.listSessions.mockResolvedValue({
      sessions: [{
        config: { role: 'backend', interviewType: 'behavioral' },
        jobDescription: 'PRIVATE JD',
        resumeText: 'PRIVATE RESUME',
      }],
    })

    const response = await GET(new NextRequest('http://localhost/api/interviews/last-config'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('prefers account-unavailable when the history query fails during deletion', async () => {
    mocks.listSessions.mockRejectedValue(new Error('session sweep interrupted query'))
    mocks.isJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await GET(new NextRequest('http://localhost/api/interviews/last-config'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
