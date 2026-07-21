import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockGenerateShareToken,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGenerateShareToken: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@learn/services/shareService', () => ({
  generateShareToken: mockGenerateShareToken,
  revokeShareToken: vi.fn(),
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
}))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const request = () => new Request('http://localhost/api/learn/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'private-session' }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockGenerateShareToken.mockResolvedValue({ token: 'private-share-token' })
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('POST /api/learn/share account lifecycle', () => {
  it('returns exact account-unavailable semantics before minting a token', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockGenerateShareToken).not.toHaveBeenCalled()
  })

  it('withholds a minted token when deletion wins before response', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when deletion removes the source session', async () => {
    mockGenerateShareToken.mockResolvedValue(null)
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when token generation fails during deletion', async () => {
    mockGenerateShareToken.mockRejectedValue(new Error('session swept'))
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await POST(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
