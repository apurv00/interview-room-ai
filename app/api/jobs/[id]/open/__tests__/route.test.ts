import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockConnectDB,
  mockResolveLiveApplyRedirect,
  mockRecordApplyOpenAttempt,
  mockCheckJobsRateLimit,
  mockRecordJobsUserEvent,
  mockLoggerError,
  mockLoggerWarn,
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
    mockRecordApplyOpenAttempt: vi.fn(),
    mockCheckJobsRateLimit: vi.fn(),
    mockRecordJobsUserEvent: vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerWarn: vi.fn(),
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
vi.mock('@jobs', () => ({ recordApplyOpenAttempt: mockRecordApplyOpenAttempt }))
vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: mockCheckJobsRateLimit,
}))
vi.mock('@jobs/services/userEventService', () => ({
  recordJobsUserEvent: mockRecordJobsUserEvent,
}))
vi.mock('@shared/logger', () => ({
  logger: { error: mockLoggerError, warn: mockLoggerWarn },
}))

import { GET, POST } from '../route'

const USER_ID = '507f1f77bcf86cd799439001'
const POSTING_ID = '507f1f77bcf86cd799439011'
const OPTION_ID = `ao2_${'a'.repeat(43)}`
const DESTINATION = 'https://boards.greenhouse.io/acme/jobs/123'

function request(
  method: 'GET' | 'POST',
  intent: string | null,
  optionId = OPTION_ID,
) {
  const intentParam = intent == null ? '' : `&intent=${intent}`
  return new Request(
    `http://localhost/api/jobs/${POSTING_ID}/open?optionId=${optionId}${intentParam}`,
    { method },
  )
}

beforeEach(() => {
  mockGetServerSession.mockReset().mockResolvedValue({ user: { id: USER_ID } })
  mockConnectDB.mockReset().mockResolvedValue(undefined)
  mockResolveLiveApplyRedirect.mockReset().mockResolvedValue(DESTINATION)
  mockRecordApplyOpenAttempt.mockReset().mockResolvedValue({
    status: 'apply_clicked',
    created: true,
    transitioned: true,
    canonicalOption: {
      optionId: OPTION_ID,
      url: DESTINATION,
      tier: 'direct-ats',
      subject: 'source:greenhouse',
      generation: 'generation-1',
      incidentVersion: 0,
      broken: false,
    },
  })
  mockCheckJobsRateLimit.mockReset().mockResolvedValue(null)
  mockRecordJobsUserEvent.mockReset().mockResolvedValue(true)
  mockLoggerError.mockReset()
  mockLoggerWarn.mockReset()
})

describe('GET/POST /api/jobs/[id]/open', () => {
  it('records Apply on POST and redirects with 303 so the employer receives GET', async () => {
    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(DESTINATION)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockRecordApplyOpenAttempt).toHaveBeenCalledWith(USER_ID, POSTING_ID, OPTION_ID)
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs.apply_click',
      userId: USER_ID,
      jobPostingId: POSTING_ID,
      props: {
        tier: 'direct-ats',
        source: 'trusted-open',
        transitioned: true,
        evidenceVersion: 1,
      },
    }))
  })

  it('redirects View on GET without recording Apply status or governance evidence', async () => {
    const response = await GET(request('GET', 'view'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(DESTINATION)
    expect(mockResolveLiveApplyRedirect).toHaveBeenCalledWith(USER_ID, POSTING_ID, OPTION_ID)
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('uses the transaction-returned canonical URL as final Apply authority', async () => {
    const currentDestination = 'https://jobs.acme.example/current/123'
    mockRecordApplyOpenAttempt.mockResolvedValueOnce({
      status: 'apply_clicked',
      created: false,
      transitioned: false,
      canonicalOption: {
        optionId: OPTION_ID,
        url: currentDestination,
        tier: 'employer',
        subject: 'source:acme',
        generation: 'generation-2',
        incidentVersion: 1,
        broken: false,
      },
    })

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(currentDestination)
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      props: {
        tier: 'employer',
        source: 'trusted-open',
        transitioned: false,
        evidenceVersion: 1,
      },
    }))
  })

  it('keeps the successful redirect when trusted-open telemetry fails', async () => {
    mockRecordJobsUserEvent.mockRejectedValueOnce(new Error('telemetry unavailable'))

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(DESTINATION)
    await vi.waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'jobs.apply_click telemetry write failed',
      )
    })
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('returns the authorized 303 without waiting for unresolved telemetry', async () => {
    mockRecordJobsUserEvent.mockReturnValueOnce(new Promise(() => undefined))
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const response = await Promise.race([
      POST(request('POST', 'apply'), { params: { id: POSTING_ID } }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('authorized redirect waited for telemetry')),
          500,
        )
      }),
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(DESTINATION)
  })

  it('rejects GET intent=apply before auth, rate limiting, or database work', async () => {
    const response = await GET(request('GET', 'apply'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(404)
    expect(mockGetServerSession).not.toHaveBeenCalled()
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('rejects POST intent=view before auth, rate limiting, or database work', async () => {
    const response = await POST(request('POST', 'view'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(404)
    expect(mockGetServerSession).not.toHaveBeenCalled()
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', null],
    ['GET', ''],
    ['GET', 'preview'],
    ['POST', null],
    ['POST', ''],
    ['POST', 'APPLY'],
  ] as const)('rejects %s with missing or invalid intent %s before database work', async (method, intent) => {
    const response = method === 'GET'
      ? await GET(request(method, intent), { params: { id: POSTING_ID } })
      : await POST(request(method, intent), { params: { id: POSTING_ID } })

    expect(response.status).toBe(404)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns a generic URL-free error when the option is no longer current', async () => {
    mockResolveLiveApplyRedirect.mockResolvedValueOnce(null)

    const response = await GET(request('GET', 'view'), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toContain('destination unavailable')
    expect(body).not.toContain(DESTINATION)
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('fails closed without exposing the destination when the Apply attempt loses authority', async () => {
    mockRecordApplyOpenAttempt.mockResolvedValueOnce(null)

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).not.toContain(DESTINATION)
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns ACCOUNT_UNAVAILABLE without a destination for an inactive account', async () => {
    mockRecordApplyOpenAttempt.mockRejectedValueOnce(new MockJobsAccountInactiveError(USER_ID))

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(401)
    expect(body).toContain('ACCOUNT_UNAVAILABLE')
    expect(body).not.toContain(DESTINATION)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('does not echo a URL contained in an unexpected error', async () => {
    mockRecordApplyOpenAttempt.mockRejectedValueOnce(new Error(`failed for ${DESTINATION}`))

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(body).not.toContain(DESTINATION)
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(DESTINATION)
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('preserves private no-store headers on identity rate-limit responses', async () => {
    mockCheckJobsRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
    )

    const response = await POST(request('POST', 'apply'), { params: { id: POSTING_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mockResolveLiveApplyRedirect).not.toHaveBeenCalled()
    expect(mockRecordApplyOpenAttempt).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})
