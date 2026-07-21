import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockComputeComparison,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockComputeComparison: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@learn/services/comparisonService', () => ({ computeComparison: mockComputeComparison }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
}))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const request = () => new Request('http://localhost/api/learn/comparison?overall=80')

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockComputeComparison.mockResolvedValue({ sessionsCompared: 3, overallDelta: 4 })
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('GET /api/learn/comparison account lifecycle', () => {
  it('returns exact account-unavailable semantics before computing history', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockComputeComparison).not.toHaveBeenCalled()
  })

  it('withholds captured comparison when deletion wins before response', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when comparison lookup fails during deletion', async () => {
    mockComputeComparison.mockRejectedValue(new Error('session sweep interrupted query'))
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
