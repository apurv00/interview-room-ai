import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockConnectDB,
  mockResolveLiveApplyRedirect,
  mockCheckJobsRateLimit,
  mockLoggerError,
  MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
    }
  }
  return {
    mockGetServerSession: vi.fn(),
    mockConnectDB: vi.fn(),
    mockResolveLiveApplyRedirect: vi.fn(),
    mockCheckJobsRateLimit: vi.fn(),
    mockLoggerError: vi.fn(),
    MockJobsAccountInactiveError,
  }
})

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: MockJobsAccountInactiveError,
}))
vi.mock('@jobs/services/applyRedirectService', () => ({
  resolveLiveApplyRedirect: mockResolveLiveApplyRedirect,
}))
vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: mockCheckJobsRateLimit,
}))
vi.mock('@shared/logger', () => ({
  logger: { error: mockLoggerError },
}))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439001'
const POSTING_ID = '507f1f77bcf86cd799439011'
const OPTION_ID = `ao1_${'a'.repeat(43)}`
const DESTINATION = 'https://boards.greenhouse.io/acme/jobs/123'

function request(optionId = OPTION_ID) {
  return new Request(`http://localhost/api/jobs/${POSTING_ID}/open?optionId=${optionId}`)
}

beforeEach(() => {
  mockGetServerSession.mockReset().mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockReset().mockResolvedValue(undefined)
  mockResolveLiveApplyRedirect.mockReset().mockResolvedValue(DESTINATION)
  mockCheckJobsRateLimit.mockReset().mockResolvedValue(null)
  mockLoggerError.mockReset()
})

describe('GET /api/jobs/[id]/open', () => {
  it('redirects to the freshly resolved safe destination with private headers', async () => {
    const response = await GET(request(), { params: { id: POSTING_ID } })

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(DESTINATION)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockResolveLiveApplyRedirect).toHaveBeenCalledWith(USER_ID, POSTING_ID, OPTION_ID)
  })

  it('returns a generic URL-free error when the option is no longer current', async () => {
    mockResolveLiveApplyRedirect.mockResolvedValueOnce(null)

    const response = await GET(request(), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toContain('destination unavailable')
    expect(body).not.toContain(DESTINATION)
  })

  it('returns ACCOUNT_UNAVAILABLE without a destination for an inactive account', async () => {
    mockResolveLiveApplyRedirect.mockRejectedValueOnce(new MockJobsAccountInactiveError(USER_ID))

    const response = await GET(request(), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(401)
    expect(body).toContain('ACCOUNT_UNAVAILABLE')
    expect(body).not.toContain(DESTINATION)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('does not echo a URL contained in an unexpected error', async () => {
    mockResolveLiveApplyRedirect.mockRejectedValueOnce(new Error(`failed for ${DESTINATION}`))

    const response = await GET(request(), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(body).not.toContain(DESTINATION)
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(DESTINATION)
  })

  it('preserves private no-store headers on identity rate-limit responses', async () => {
    mockCheckJobsRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
    )

    const response = await GET(request(), { params: { id: POSTING_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
  })
})
