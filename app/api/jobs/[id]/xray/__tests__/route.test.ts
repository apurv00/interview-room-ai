import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetServerSession, mockConnectDB, mockGetOrParseXray } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetOrParseXray: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs', () => ({ getOrParseXray: mockGetOrParseXray }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
})

describe('GET /api/jobs/[id]/xray owner-aware cache policy', () => {
  it('passes the exact session user to the service and keeps the response private', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetOrParseXray.mockResolvedValue({
      cached: true,
      parsed: { role: 'Backend Engineer', inferredDomain: 'backend', keyThemes: ['payments'], requirements: [] },
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}/xray`), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockGetOrParseXray).toHaveBeenCalledWith(JOB_ID, USER_ID)
  })

  it('makes an authenticated non-owner/missing result private and non-cacheable', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetOrParseXray.mockResolvedValue(null)

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}/xray`), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects a session without an authoritative user id before database work', async () => {
    mockGetServerSession.mockResolvedValue({ user: {} })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}/xray`), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockGetOrParseXray).not.toHaveBeenCalled()
  })
})
