import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockIsJobsAccountActive,
  mockRecordJobsUserEvent,
  mockRecordApplyClick,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
  mockRecordApplyClick: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: (...args: unknown[]) => mockIsJobsAccountActive(...args),
}))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@jobs/services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))
vi.mock('@jobs', () => ({ recordApplyClick: mockRecordApplyClick }))

import { POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const OPTION_ID = `ao2_${'a'.repeat(43)}`

function request(body: BodyInit) {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/apply-click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockConnectDB.mockResolvedValue(undefined)
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('POST /api/jobs/[id]/apply-click retired compatibility boundary', () => {
  it('requires authentication without touching rate limits, payloads, or state', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const json = vi.fn()

    const response = await POST({ json } as unknown as Request, { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(json).not.toHaveBeenCalled()
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockRecordApplyClick).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('applies the authenticated rate limit without parsing or mutating', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, { status: 429 }))
    const json = vi.fn()

    const response = await POST({ json } as unknown as Request, { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(json).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockRecordApplyClick).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('preserves account-unavailable semantics for inactive users without parsing or writing', async () => {
    mockIsJobsAccountActive.mockResolvedValueOnce(false)
    const json = vi.fn()

    const response = await POST({ json } as unknown as Request, { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockConnectDB).toHaveBeenCalledTimes(1)
    expect(mockIsJobsAccountActive).toHaveBeenCalledWith(USER_ID)
    expect(json).not.toHaveBeenCalled()
    expect(mockRecordApplyClick).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['valid current payload', JSON.stringify({ optionId: OPTION_ID }), JOB_ID],
    ['malformed JSON', '{', JOB_ID],
    ['empty payload', '{}', JOB_ID],
    ['legacy URL/tier payload', JSON.stringify({ url: 'https://evil.example', tier: 'direct-ats' }), JOB_ID],
    ['spoofed URL beside id', JSON.stringify({ optionId: OPTION_ID, url: 'https://evil.example' }), JOB_ID],
    ['malformed option id', JSON.stringify({ optionId: 'ao2_short' }), JOB_ID],
    ['malformed posting id', JSON.stringify({ optionId: OPTION_ID }), 'not-an-object-id'],
  ])('returns the same mutation-free 410 for %s', async (_name, body, postingId) => {
    const response = await POST(request(body), { params: { id: postingId } })

    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: 'apply-click endpoint retired',
      code: 'APPLY_CLICK_DEPRECATED',
      replacement: '/api/jobs/[id]/open?intent=apply',
    })
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockConnectDB).toHaveBeenCalledTimes(1)
    expect(mockIsJobsAccountActive).toHaveBeenCalledWith(USER_ID)
    expect(mockRecordApplyClick).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})
