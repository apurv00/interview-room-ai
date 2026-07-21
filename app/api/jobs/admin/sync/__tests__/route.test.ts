import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockConnectDB,
  mockControlRevisionOf,
  mockGetServerSession,
  mockSend,
  mockSourceFindOne,
  mockCheckJobsRateLimit,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockControlRevisionOf: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockSend: vi.fn(),
  mockSourceFindOne: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/services/inngest', () => ({
  inngest: { send: (...args: unknown[]) => mockSend(...args) },
}))
vi.mock('@shared/db/connection', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobSourceConfig: { findOne: (...args: unknown[]) => mockSourceFindOne(...args) },
}))
vi.mock('@jobs/services/sourceControl', () => ({
  controlRevisionOf: (...args: unknown[]) => mockControlRevisionOf(...args),
}))
vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: (...args: unknown[]) => mockCheckJobsRateLimit(...args),
}))

import { POST } from '../route'

const URL = 'http://localhost/api/jobs/admin/sync'

function request(body: unknown) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function mockSource(source: object | null) {
  const lean = vi.fn().mockResolvedValue(source)
  const select = vi.fn().mockReturnValue({ lean })
  mockSourceFindOne.mockReturnValue({ select })
  return { select, lean }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: 'admin-1', role: 'platform_admin' } })
  mockConnectDB.mockResolvedValue(undefined)
  mockSend.mockResolvedValue(undefined)
  mockControlRevisionOf.mockReturnValue(7)
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockSource({ sourceId: 'gh:phonepe', enabled: true, health: 'active', controlRevision: 7 })
})

describe('POST /api/jobs/admin/sync', () => {
  it('applies the admin command budget before parsing or dispatch work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    }))
    const body = { sourceId: 'gh:phonepe' }

    const response = await POST(request(body))

    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith('admin-1', 'admin-command')
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('returns 401 for anonymous requests and dispatches nothing', async () => {
    mockGetServerSession.mockResolvedValue(null)

    const response = await POST(request({ sourceId: 'gh:phonepe' }))

    expect(response.status).toBe(401)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('returns 403 for a non-platform admin and dispatches nothing', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'candidate-1', role: 'candidate' } })

    const response = await POST(request({ sourceId: 'gh:phonepe' }))

    expect(response.status).toBe(403)
    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('dispatches an eligible source with its current control revision', async () => {
    const source = { sourceId: 'gh:phonepe', enabled: true, health: 'degraded', controlRevision: 11 }
    const chain = mockSource(source)
    mockControlRevisionOf.mockReturnValue(11)

    const response = await POST(request({ sourceId: source.sourceId }))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(mockSourceFindOne).toHaveBeenCalledWith({ sourceId: source.sourceId })
    expect(chain.select).toHaveBeenCalledWith('sourceId enabled health controlRevision')
    expect(mockControlRevisionOf).toHaveBeenCalledWith(source)
    expect(mockSend).toHaveBeenCalledWith({
      name: 'jobs/source.sync',
      data: { sourceId: source.sourceId, controlRevision: 11 },
    })
    expect(payload).toEqual({ dispatched: source.sourceId, controlRevision: 11 })
  })

  it('returns 404 and does not dispatch an unknown source', async () => {
    mockSource(null)

    const response = await POST(request({ sourceId: 'missing-source' }))

    expect(response.status).toBe(404)
    expect(mockControlRevisionOf).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it.each([
    [{ sourceId: 'disabled', enabled: false, health: 'active', controlRevision: 2 }, 'disabled'],
    [{ sourceId: 'revoked', enabled: true, health: 'revoked', controlRevision: 3 }, 'revoked'],
    [{ sourceId: 'quarantined', enabled: true, health: 'quarantined', controlRevision: 4 }, 'quarantined'],
  ])('returns 409 for an ineligible source: %s (%s)', async (source) => {
    mockSource(source)

    const response = await POST(request({ sourceId: source.sourceId }))

    expect(response.status).toBe(409)
    expect(mockControlRevisionOf).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('preserves the manual verdict sweep and floors a positive limit', async () => {
    const response = await POST(request({ mode: 'verdict-sweep', limit: 12.9 }))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(mockSend).toHaveBeenCalledWith({ name: 'jobs/verdict.sweep', data: { limit: 12 } })
    expect(payload).toEqual({ dispatched: 'verdict-sweep' })
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSourceFindOne).not.toHaveBeenCalled()
  })

  it('defaults an empty request body to the jsearch source', async () => {
    mockSource({ sourceId: 'jsearch', enabled: true, health: 'active' })
    mockControlRevisionOf.mockReturnValue(0)
    const empty = new Request(URL, { method: 'POST' })

    const response = await POST(empty)

    expect(response.status).toBe(200)
    expect(mockSourceFindOne).toHaveBeenCalledWith({ sourceId: 'jsearch' })
    expect(mockSend).toHaveBeenCalledWith({
      name: 'jobs/source.sync',
      data: { sourceId: 'jsearch', controlRevision: 0 },
    })
  })
})
