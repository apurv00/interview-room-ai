import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  saveBaseResume: vi.fn(),
  getBaseResume: vi.fn(),
  checkJobsRateLimit: vi.fn(),
  isJobsAccountActive: vi.fn(),
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {},
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
  JobsAccountInactiveError: mocks.JobsAccountInactiveError,
}))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))

import { GET, POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const postRequest = (originUserId: string | null = USER_ID) => new Request('http://localhost/api/jobs/base-resume', {
  method: 'POST',
  headers: originUserId === null ? undefined : { 'x-origin-user-id': originUserId },
  body: JSON.stringify({
    resume: { contactInfo: { fullName: 'A', email: 'a@example.com' } },
    targetRole: 'Backend Engineer',
  }),
})

const rawPostRequest = (body: string, extraHeaders: HeadersInit = {}) => new Request('http://localhost/api/jobs/base-resume', {
  method: 'POST',
  headers: { 'x-origin-user-id': USER_ID, ...extraHeaders },
  body,
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
  it('rejects an account switch before rate limiting or database work', async () => {
    const response = await POST(postRequest('507f1f77bcf86cd799439099'))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'account changed',
      code: 'ACCOUNT_CHANGED',
    })
    expect(mocks.checkJobsRateLimit).not.toHaveBeenCalled()
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.saveBaseResume).not.toHaveBeenCalled()
  })

  it('rejects a missing captured identity before rate limiting or database work', async () => {
    const response = await POST(postRequest(null))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    expect(mocks.checkJobsRateLimit).not.toHaveBeenCalled()
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('accepts the captured identity for the active session', async () => {
    const response = await POST(postRequest(USER_ID))

    expect(response.status).toBe(200)
    expect(mocks.saveBaseResume).toHaveBeenCalledTimes(1)
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('rejects null and array bodies without throwing or touching the database', async () => {
    for (const body of ['null', '[]']) {
      const response = await POST(rawPostRequest(body))
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.saveBaseResume).not.toHaveBeenCalled()
  })

  it('rejects an actually oversized body before JSON parsing or database work', async () => {
    const response = await POST(rawPostRequest(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })))

    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.saveBaseResume).not.toHaveBeenCalled()
  })

  it('returns 401 and reads no resume after account deletion begins', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
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
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('returns 401 and saves nothing after account deletion begins', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    const response = await POST(postRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.saveBaseResume).not.toHaveBeenCalled()
  })

  it('returns the same 401 contract when deletion wins inside the save service', async () => {
    mocks.saveBaseResume.mockRejectedValueOnce(new mocks.JobsAccountInactiveError())

    const response = await POST(postRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
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
