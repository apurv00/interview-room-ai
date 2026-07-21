import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  mockGetServerSession,
  mockFindOne,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindOne: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models/MultimodalAnalysis', () => ({
  MultimodalAnalysis: { findOne: mockFindOne },
}))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'

function callRoute() {
  return GET(new NextRequest('http://localhost/api/analysis/session-1'), {
    params: { sessionId: 'session-1' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockFindOne.mockResolvedValue({
    status: 'completed',
    whisperTranscript: 'private transcript',
  })
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('GET /api/analysis/[sessionId] account lifecycle', () => {
  it('returns exact account-unavailable semantics before reading analysis', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('withholds captured analysis when deletion wins before response', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when deletion removes the analysis row', async () => {
    mockFindOne.mockResolvedValue(null)
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when the analysis read fails during deletion', async () => {
    mockFindOne.mockRejectedValue(new Error('query interrupted'))
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
