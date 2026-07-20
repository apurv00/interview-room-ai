import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockPostingFindById, mockPostingUpdateOne,
  mockApplicationFindOne, mockApplicationCreate, mockEventCreate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockApplicationFindOne: vi.fn(),
  mockApplicationCreate: vi.fn(),
  mockEventCreate: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobPosting: { findById: mockPostingFindById, updateOne: mockPostingUpdateOne },
  JobApplication: { findOne: mockApplicationFindOne, create: mockApplicationCreate },
  ProductEvent: { create: mockEventCreate },
}))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockResolvedValue(undefined)
  mockPostingFindById.mockReturnValue(selectLean({
    title: 'Backend Engineer', company: 'Acme', locations: ['Pune'], provenance: [], status: 'open',
  }))
  mockApplicationFindOne.mockReturnValue(selectLean(null))
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockApplicationCreate.mockResolvedValue({})
  mockEventCreate.mockResolvedValue({})
})

describe('POST /api/jobs/[id]/save open-state ownership fence', () => {
  it('creates only after an atomic open-posting pin succeeds', async () => {
    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      { _id: JOB_ID, status: 'open' },
      { $set: { userReferenced: true }, $unset: { purgeAt: 1 } },
    )
    expect(mockApplicationCreate).toHaveBeenCalledTimes(1)
  })

  it('does not create ownership when closure wins the pin race', async () => {
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockApplicationCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('keeps an existing owner idempotent without regressing application state', async () => {
    mockApplicationFindOne.mockReturnValue(selectLean({ status: 'applied' }))

    const response = await POST(new Request(`http://localhost/api/jobs/${JOB_ID}/save`, { method: 'POST' }), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true, status: 'applied', alreadySaved: true })
    expect(mockApplicationCreate).not.toHaveBeenCalled()
  })
})
