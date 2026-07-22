import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockRecordInterviewOutcome,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockRecordInterviewOutcome: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@jobs', () => ({
  INTERVIEW_OUTCOME_RESULTS: ['advanced', 'waiting', 'rejected', 'offer', 'skip'],
  INTERVIEW_OUTCOME_CORRECTION_STATUSES: [
    'interview_scheduled', 'interviewed', 'offer', 'rejected', 'ghosted', 'withdrawn',
  ],
  recordInterviewOutcome: mockRecordInterviewOutcome,
}))

import { POST } from '../route'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'

function request(
  body: unknown = { result: 'advanced', round: 1 },
  raw = false,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/outcome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ? String(body) : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockConnectDB.mockResolvedValue(undefined)
  mockRecordInterviewOutcome.mockResolvedValue({
    ok: true,
    changed: true,
    deferred: false,
    status: 'interview_scheduled',
    outcome: {
      interviewRounds: 1,
      latestResult: 'advanced',
      latestRound: 1,
      revision: 1,
      askCount: 0,
    },
  })

})

describe('POST /api/jobs/[id]/outcome', () => {
  it('passes a correction only with its exact revision and lifecycle status', async () => {
    const response = await POST(request({
      result: 'offer',
      round: 3,
      expectedRevision: 7,
      expectedStatus: 'rejected',
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockRecordInterviewOutcome).toHaveBeenCalledWith(USER_ID, JOB_ID, {
      result: 'offer',
      round: 3,
      expectedRevision: 7,
      expectedStatus: 'rejected',
    })
  })

  it('requires authentication before rate-limit or database work', async () => {
    mockGetServerSession.mockResolvedValueOnce(null)

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'sign in required' })
    expect(mockCheckJobsRateLimit).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('passes a strict canonical report to the owner-fenced service', async () => {
    const response = await POST(
      request({ result: 'waiting', round: 3 }),
      { params: { id: JOB_ID } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(mockConnectDB).toHaveBeenCalledOnce()
    expect(mockRecordInterviewOutcome).toHaveBeenCalledWith(
      USER_ID,
      JOB_ID,
      { result: 'waiting', round: 3 },
    )
    expect(await response.json()).toMatchObject({
      ok: true,
      changed: true,
      status: 'interview_scheduled',
    })
  })

  it('rejects malformed, extra, and out-of-range input before database work', async () => {
    for (const [body, raw] of [
      ['{bad-json', true],
      [{ result: 'advanced', round: 1, extra: true }, false],
      [{ result: 'unknown', round: 1 }, false],
      [{ result: 'offer', round: 0 }, false],
      [{ result: 'offer', round: 1.5 }, false],
      [{ result: 'offer', round: 101 }, false],
      [{ result: 'offer', round: 1, expectedRevision: 1 }, false],
      [{ result: 'offer', round: 1, expectedRevision: 0, expectedStatus: 'rejected' }, false],
      [{ result: 'offer', round: 1, expectedRevision: 1, expectedStatus: 'saved' }, false],
      [{ result: 'skip', round: 1, expectedRevision: 1, expectedStatus: 'rejected' }, false],
      [[], false],
    ] as Array<[unknown, boolean]>) {
      const response = await POST(request(body, raw), { params: { id: JOB_ID } })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_OUTCOME' })
    }
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockRecordInterviewOutcome).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid id or a missing/ineligible owner application', async () => {
    const invalidId = await POST(request(), { params: { id: 'not-an-object-id' } })
    expect(invalidId.status).toBe(404)

    mockRecordInterviewOutcome.mockResolvedValueOnce({
      ok: false,
      reason: 'ineligible',
      currentRound: 0,
    })
    const ineligible = await POST(request(), { params: { id: JOB_ID } })
    expect(ineligible.status).toBe(404)
    expect(await ineligible.json()).toEqual({ error: 'not found' })
  })

  it('maps stale outcome state to a retryable 409', async () => {
    mockRecordInterviewOutcome.mockResolvedValueOnce({
      ok: false,
      reason: 'round-conflict',
      currentRound: 2,
    })

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'interview outcome changed; refresh and try again',
      code: 'OUTCOME_STATE_CONFLICT',
      currentRound: 2,
    })
  })

  it('rejects declared and observed bodies above 1 KiB before database work', async () => {
    const declared = await POST(
      request({ result: 'advanced', round: 1 }, false, { 'content-length': '1025' }),
      { params: { id: JOB_ID } },
    )
    const observed = await POST(
      request(JSON.stringify({ result: 'advanced', round: 1, padding: 'x'.repeat(1100) }), true),
      { params: { id: JOB_ID } },
    )

    expect(declared.status).toBe(413)
    expect(observed.status).toBe(413)
    await expect(declared.json()).resolves.toMatchObject({ code: 'OUTCOME_REQUEST_TOO_LARGE' })
    await expect(observed.json()).resolves.toMatchObject({ code: 'OUTCOME_REQUEST_TOO_LARGE' })
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockRecordInterviewOutcome).not.toHaveBeenCalled()
  })

  it('uses the account-unavailable contract when deletion owns the write fence', async () => {
    mockRecordInterviewOutcome.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('returns the limiter response with private no-store caching', async () => {
    const limited = new Response(JSON.stringify({ error: 'too many requests' }), { status: 429 })
    mockCheckJobsRateLimit.mockResolvedValueOnce(limited)

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it('does not hide unexpected service failures', async () => {
    mockRecordInterviewOutcome.mockRejectedValueOnce(new Error('database failed'))

    await expect(POST(request(), { params: { id: JOB_ID } })).rejects.toThrow('database failed')
  })
})
