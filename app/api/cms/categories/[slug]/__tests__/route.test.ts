import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetServerSession, mockCount, mockFOAU } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCount: vi.fn(),
  mockFOAU: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: (...a: unknown[]) => mockGetServerSession(...a) }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  Category: {
    findOneAndUpdate: (...a: unknown[]) => {
      mockFOAU(...a)
      return { lean: () => Promise.resolve({ slug: 'core-engineering' }) }
    },
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  InterviewDomain: { countDocuments: (...a: unknown[]) => mockCount(...a) },
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { PUT } from '../route'

const params = { params: { slug: 'core-engineering' } }
const req = (body: object) =>
  new NextRequest('http://localhost/api/cms/categories/core-engineering', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: 'u1', role: 'platform_admin' } })
})

describe('PUT /api/cms/categories/[slug] — deactivation orphan guard', () => {
  it('409s when deactivating a category still used by active roles', async () => {
    mockCount.mockResolvedValue(2)
    const res = await PUT(req({ isActive: false }), params)
    expect(res.status).toBe(409)
    expect(mockFOAU).not.toHaveBeenCalled()
  })

  it('allows deactivation when no active role uses it', async () => {
    mockCount.mockResolvedValue(0)
    const res = await PUT(req({ isActive: false }), params)
    expect(res.status).toBe(200)
    expect(mockFOAU).toHaveBeenCalled()
  })

  it('does not run the guard for non-deactivation updates', async () => {
    const res = await PUT(req({ label: 'Renamed' }), params)
    expect(res.status).toBe(200)
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('403 for a non-admin session', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'u1', role: 'candidate' } })
    const res = await PUT(req({ isActive: false }), params)
    expect(res.status).toBe(403)
  })
})
