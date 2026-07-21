import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  saveBaseResume: vi.fn(),
  getBaseResume: vi.fn(),
  checkJobsRateLimit: vi.fn(),
  isJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@jobs', () => ({
  saveBaseResume: mocks.saveBaseResume,
  getBaseResume: mocks.getBaseResume,
}))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mocks.checkJobsRateLimit }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))

import { GET, POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const postRequest = () => new Request('http://localhost/api/jobs/base-resume', {
  method: 'POST',
  body: JSON.stringify({
    resume: { contactInfo: { fullName: 'A', email: 'a@example.com' } },
    targetRole: 'Backend Engineer',
  }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.checkJobsRateLimit.mockResolvedValue(null)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.getBaseResume.mockResolvedValue(null)
  mocks.saveBaseResume.mockResolvedValue({ saved: true, id: 'resume-1', updated: false })
})

describe('/api/jobs/base-resume account-state guard', () => {
  it('returns 401 and reads no resume after account deletion begins', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    const response = await GET()

    expect(response.status).toBe(401)
    expect(mocks.getBaseResume).not.toHaveBeenCalled()
  })

  it('discards the base-resume projection when deletion commits during the read', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.getBaseResume.mockResolvedValue({
      id: 'resume-private',
      targetRole: 'Backend Engineer',
      resume: { contactInfo: { email: 'private@example.com' } },
    })

    const response = await GET()

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body).toEqual({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' })
    expect(body).not.toHaveProperty('base')
    expect(mocks.getBaseResume).toHaveBeenCalledWith(USER_ID)
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('returns the base resume only after the active account survives the final recheck', async () => {
    const base = { id: 'resume-1', targetRole: 'Backend Engineer' }
    mocks.getBaseResume.mockResolvedValue(base)

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ base })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('returns 401 and saves nothing after account deletion begins', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    const response = await POST(postRequest())

    expect(response.status).toBe(401)
    expect(mocks.saveBaseResume).not.toHaveBeenCalled()
  })

  it('continues the active-account save contract', async () => {
    const response = await POST(postRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ saved: true, id: 'resume-1', updated: false })
    expect(mocks.saveBaseResume).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Object),
      'Backend Engineer',
      undefined,
    )
  })
})
