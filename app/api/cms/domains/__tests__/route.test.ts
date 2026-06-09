import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetServerSession, mockCreate, mockExists } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCreate: vi.fn(),
  mockExists: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: (...a: unknown[]) => mockGetServerSession(...a) }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/db/models', () => ({
  InterviewDomain: { create: (...a: unknown[]) => mockCreate(...a) },
  Category: { exists: (...a: unknown[]) => mockExists(...a) },
}))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { POST } from '../route'

const base = { slug: 'mechanical', label: 'Mechanical', shortLabel: 'ME', icon: '⚙️', description: 'Thermo/CAD' }
const req = (body: object) =>
  new NextRequest('http://localhost/api/cms/domains', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: 'u1', role: 'platform_admin' } })
  mockCreate.mockResolvedValue({ slug: 'mechanical' })
})

describe('POST /api/cms/domains — write-time categorySlug validation', () => {
  it('400s when categorySlug is not an existing active category', async () => {
    mockExists.mockResolvedValue(null)
    const res = await POST(req({ ...base, categorySlug: 'renewable-energy' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates when categorySlug references an active category', async () => {
    mockExists.mockResolvedValue({ _id: 'x' })
    const res = await POST(req({ ...base, categorySlug: 'core-engineering' }))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalled()
  })

  it('creates without a categorySlug (no category check)', async () => {
    const res = await POST(req(base))
    expect(res.status).toBe(201)
    expect(mockExists).not.toHaveBeenCalled()
  })

  it('403 for a non-admin session', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'u1', role: 'candidate' } })
    const res = await POST(req({ ...base, categorySlug: 'core-engineering' }))
    expect(res.status).toBe(403)
  })
})
