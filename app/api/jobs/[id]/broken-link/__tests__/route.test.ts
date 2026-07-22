import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockRecordJobsUserEvent,
  mockReportBrokenLink,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
  mockReportBrokenLink: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@jobs/services/userEventService', () => ({ recordJobsUserEvent: mockRecordJobsUserEvent }))
vi.mock('@jobs', async () => {
  const identity = await vi.importActual<typeof import('@jobs/services/applyOptionIdentity')>(
    '@jobs/services/applyOptionIdentity',
  )
  return { ...identity, reportBrokenLink: mockReportBrokenLink }
})

import { POST } from '../route'
import { applyOptionIdOf } from '@jobs/services/applyOptionIdentity'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const OPTION_ID = applyOptionIdOf({
  sourceKey: 'source:1',
  url: 'https://employer.example/apply',
  tier: 'employer',
})

function request(body: BodyInit) {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/broken-link`, {
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
  mockRecordJobsUserEvent.mockResolvedValue(true)
  mockReportBrokenLink.mockResolvedValue({
    ok: true,
    recorded: true,
    optionId: OPTION_ID,
    tier: 'employer',
    hadFailover: true,
    disposition: 'pending-verification',
  })
})

describe('POST /api/jobs/[id]/broken-link canonical option boundary', () => {
  it('applies the authenticated mutation budget before parsing or database work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, { status: 429 }))
    const json = vi.fn()

    const response = await POST({ json } as unknown as Request, { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID, 'broken-link')
    expect(json).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['empty payload', '{}'],
    ['legacy spoofed telemetry', JSON.stringify({ url: 'https://evil.example', tier: 'direct-ats', hadFailover: false })],
    ['extra client telemetry', JSON.stringify({ optionId: OPTION_ID, tier: 'direct-ats', hadFailover: false })],
    ['malformed id', JSON.stringify({ optionId: 'ao1_short' })],
  ])('rejects %s before connecting to the database', async (_name, body) => {
    const response = await POST(request(body), { params: { id: JOB_ID } })

    expect(response.status).toBe(400)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockReportBrokenLink).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns not-found for a stale, unclicked, or cross-user option without telemetry', async () => {
    mockReportBrokenLink.mockResolvedValue({ ok: false })

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockReportBrokenLink).toHaveBeenCalledWith(USER_ID, JOB_ID, OPTION_ID)
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns the account-unavailable contract when deletion owns the write fence', async () => {
    mockReportBrokenLink.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it.each([
    'pending-verification',
    'crowd-demoted',
    'machine-demoted',
  ] as const)('returns the truthful %s disposition without exposing quorum counts', async (disposition) => {
    mockReportBrokenLink.mockResolvedValueOnce({
      ok: true,
      recorded: true,
      optionId: OPTION_ID,
      tier: 'employer',
      hadFailover: true,
      disposition,
    })

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({ ok: true, disposition, alreadyReported: false })
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs.broken_link',
      props: { tier: 'employer', hadFailover: true },
    }))
  })

  it('returns an idempotent duplicate without emitting duplicate telemetry', async () => {
    mockReportBrokenLink.mockResolvedValue({
      ok: true,
      recorded: false,
      optionId: OPTION_ID,
      tier: 'employer',
      hadFailover: true,
      disposition: 'crowd-demoted',
    })

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(await response.json()).toEqual({
      ok: true,
      disposition: 'crowd-demoted',
      alreadyReported: true,
    })
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })
})
