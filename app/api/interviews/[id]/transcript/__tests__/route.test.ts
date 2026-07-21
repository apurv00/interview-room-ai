import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

const {
  mockGetServerSession,
  mockFindById,
  mockCanViewSession,
  mockIsJobsAccountActive,
  mockActiveJobsAccountIds,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindById: vi.fn(),
  mockCanViewSession: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockActiveJobsAccountIds: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findById: (...args: unknown[]) => mockFindById(...args) },
}))
vi.mock('@shared/auth/permissions', () => ({ canViewSession: mockCanViewSession }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
  activeJobsAccountIds: (...args: unknown[]) => mockActiveJobsAccountIds(...args),
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from '../route'

const REQUESTER_ID = new mongoose.Types.ObjectId().toString()
const OWNER_ID = new mongoose.Types.ObjectId().toString()
const SESSION_ID = new mongoose.Types.ObjectId().toString()

function sessionResult(ownerId = REQUESTER_ID) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        userId: { toString: () => ownerId },
        organizationId: new mongoose.Types.ObjectId(),
        transcript: [{ role: 'candidate', text: 'private answer' }],
      }),
    }),
  }
}

function callRoute() {
  return GET(new NextRequest(`http://localhost/api/interviews/${SESSION_ID}/transcript`), {
    params: { id: SESSION_ID },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({
    user: { id: REQUESTER_ID, role: 'candidate', organizationId: undefined },
  })
  mockCanViewSession.mockReturnValue(true)
  mockFindById.mockReturnValue(sessionResult())
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockActiveJobsAccountIds.mockImplementation(
    (userIds: string[]) => Promise.resolve(new Set(userIds)),
  )
})

describe('GET /api/interviews/[id]/transcript account lifecycle', () => {
  it('returns exact account-unavailable semantics before reading a transcript', async () => {
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockFindById).not.toHaveBeenCalled()
  })

  it('hides an inactive owner from an otherwise authorized organization viewer', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: REQUESTER_ID, role: 'recruiter', organizationId: 'same-org' },
    })
    mockFindById.mockReturnValue(sessionResult(OWNER_ID))
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Interview session not found' })
  })

  it('withholds a captured transcript when requester deletion wins before response', async () => {
    mockActiveJobsAccountIds.mockResolvedValueOnce(new Set())

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([REQUESTER_ID])
  })

  it('withholds a captured transcript when a foreign owner starts deleting before response', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: REQUESTER_ID, role: 'recruiter', organizationId: 'same-org' },
    })
    mockFindById.mockReturnValue(sessionResult(OWNER_ID))
    mockActiveJobsAccountIds.mockResolvedValueOnce(new Set([REQUESTER_ID]))

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Interview session not found' })
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([REQUESTER_ID, OWNER_ID])
  })

  it('returns an active owner transcript after the final account snapshot', async () => {
    const response = await callRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      transcript: [{ role: 'candidate', text: 'private answer' }],
    })
    expect(mockActiveJobsAccountIds).toHaveBeenCalledWith([REQUESTER_ID])
  })

  it('prefers account-unavailable when deletion removes the transcript row', async () => {
    mockFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    })
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('prefers account-unavailable when the transcript read fails during deletion', async () => {
    mockFindById.mockImplementation(() => { throw new Error('query interrupted') })
    mockIsJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })
})
