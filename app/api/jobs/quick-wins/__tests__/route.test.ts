import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  getBaseResume: vi.fn(),
  getResume: vi.fn(),
  computeQuickWins: vi.fn(),
  isJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@jobs', () => ({ getBaseResume: mocks.getBaseResume }))
vi.mock('@resume', () => ({ getResume: mocks.getResume }))
vi.mock('@jobs/config/quickWins', () => ({ computeQuickWins: mocks.computeQuickWins }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
}))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const BASE_RESUME = { id: 'resume-private', targetRole: 'Backend Engineer' }
const FULL_RESUME = {
  contactInfo: { fullName: 'Private Candidate', email: 'private@example.com' },
  summary: 'Private resume content',
}
const WINS = [{ id: 'summary', title: 'Strengthen summary' }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.getBaseResume.mockResolvedValue(BASE_RESUME)
  mocks.getResume.mockResolvedValue(FULL_RESUME)
  mocks.computeQuickWins.mockReturnValue(WINS)
})

describe('GET /api/jobs/quick-wins account-state guard', () => {
  it('rejects an inactive stale-JWT account before reading either resume projection', async () => {
    mocks.isJobsAccountActive.mockResolvedValue(false)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getBaseResume).not.toHaveBeenCalled()
    expect(mocks.getResume).not.toHaveBeenCalled()
    expect(mocks.computeQuickWins).not.toHaveBeenCalled()
  })

  it('does not expose the empty no-base result when deletion wins that early-return race', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.getBaseResume.mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getResume).not.toHaveBeenCalled()
    expect(mocks.computeQuickWins).not.toHaveBeenCalled()
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('preserves the active-account no-base response after its final recheck', async () => {
    mocks.getBaseResume.mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ count: 0, wins: [] })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('does not expose the empty no-full-resume result when deletion wins that race', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.getResume.mockResolvedValue(null)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getResume).toHaveBeenCalledWith(USER_ID, BASE_RESUME.id)
    expect(mocks.computeQuickWins).not.toHaveBeenCalled()
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('discards computed wins when deletion commits after the full resume read', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await GET()

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body).toEqual({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' })
    expect(body).not.toHaveProperty('wins')
    expect(body).not.toHaveProperty('resumeId')
    expect(mocks.computeQuickWins).toHaveBeenCalledWith(FULL_RESUME)
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('returns computed wins only after the active account survives the final recheck', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      count: 1,
      wins: WINS,
      resumeId: BASE_RESUME.id,
    })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })
})
