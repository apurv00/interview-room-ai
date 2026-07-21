import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession, mockConnectDB, mockSaveTailoredVersion, mockEventCreate, mockCheckJobsRateLimit,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockSaveTailoredVersion: vi.fn(),
  mockEventCreate: vi.fn(),
  mockCheckJobsRateLimit: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs', () => ({ saveTailoredVersion: mockSaveTailoredVersion }))
vi.mock('@shared/db/models', () => ({ ProductEvent: { create: mockEventCreate } }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const SOURCE_HASH = 'a'.repeat(64)

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/tailored`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockResolvedValue(undefined)
  mockSaveTailoredVersion.mockResolvedValue({ ok: true })
  mockEventCreate.mockResolvedValue({})
  mockCheckJobsRateLimit.mockResolvedValue(null)
})

describe('POST /api/jobs/[id]/tailored provenance contract', () => {
  it('returns the authenticated-user rate limit before parsing or persistence', async () => {
    const blocked = new Response(JSON.stringify({ error: 'slow down' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    })
    mockCheckJobsRateLimit.mockResolvedValueOnce(blocked)
    const response = await POST(request({ tailoredText: 'TAILORED' }), { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSaveTailoredVersion).not.toHaveBeenCalled()
  })

  it('requires a canonical SHA-256 JD version before touching persistence', async () => {
    const response = await POST(request({ tailoredText: 'TAILORED', originUserId: USER_ID }), { params: { id: JOB_ID } })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'SOURCE_JD_HASH_REQUIRED' })
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSaveTailoredVersion).not.toHaveBeenCalled()
  })

  it('passes the source hash to the service and persists an exact-job result', async () => {
    const response = await POST(request({
      tailoredText: 'TAILORED',
      originUserId: USER_ID,
      sourceJdHash: SOURCE_HASH,
      matchScore: 81,
      addedKeywords: ['TypeScript'],
      missingKeywords: [],
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockSaveTailoredVersion).toHaveBeenCalledWith(
      USER_ID,
      JOB_ID,
      expect.objectContaining({ sourceJdHash: SOURCE_HASH, tailoredText: 'TAILORED' }),
    )
  })

  it('accepts the exact persisted text boundary without truncating it', async () => {
    const tailoredText = 'x'.repeat(60_000)
    const response = await POST(request({
      tailoredText,
      originUserId: USER_ID,
      sourceJdHash: SOURCE_HASH,
      addedKeywords: [],
      missingKeywords: [],
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockSaveTailoredVersion).toHaveBeenCalledWith(
      USER_ID,
      JOB_ID,
      expect.objectContaining({ tailoredText }),
    )
  })

  it('rejects text above the persisted boundary before DB or service work', async () => {
    const response = await POST(request({
      tailoredText: 'x'.repeat(60_001),
      originUserId: USER_ID,
      sourceJdHash: SOURCE_HASH,
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      code: 'TAILORED_TEXT_TOO_LARGE',
      identityVerified: true,
    })
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSaveTailoredVersion).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('surfaces a current-JD mismatch as a lifecycle conflict without telemetry', async () => {
    mockSaveTailoredVersion.mockResolvedValueOnce({ ok: false, reason: 'jd-mismatch' })

    const response = await POST(request({ tailoredText: 'TAILORED', sourceJdHash: SOURCE_HASH, originUserId: USER_ID }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'JOB_DESCRIPTION_CHANGED' })
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('marks a post-identity persistence failure so the client can safely reveal and retry', async () => {
    mockConnectDB.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await POST(request({
      tailoredText: 'TAILORED',
      sourceJdHash: SOURCE_HASH,
      originUserId: USER_ID,
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'ATTACHMENT_TEMPORARY',
      identityVerified: true,
    })
    expect(mockSaveTailoredVersion).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['different', '507f1f77bcf86cd799439099'],
  ])('rejects a %s originating user before any persistence work', async (_label, originUserId) => {
    const response = await POST(request({
      tailoredText: 'TAILORED',
      sourceJdHash: SOURCE_HASH,
      ...(originUserId ? { originUserId } : {}),
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'SESSION_CHANGED' })
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockSaveTailoredVersion).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })
})
