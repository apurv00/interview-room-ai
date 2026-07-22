import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockRecordJobsUserEvent,
  mockRecordApplyClick,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockRecordJobsUserEvent: vi.fn(),
  mockRecordApplyClick: vi.fn(),
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
  return { ...identity, recordApplyClick: mockRecordApplyClick }
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
  mockRecordJobsUserEvent.mockResolvedValue(true)
  mockRecordApplyClick.mockResolvedValue({
    status: 'apply_clicked',
    created: true,
    transitioned: true,
    canonicalOption: { optionId: OPTION_ID, tier: 'employer' },
  })
})

describe('POST /api/jobs/[id]/apply-click canonical option boundary', () => {
  it('applies the authenticated mutation budget before parsing or database work', async () => {
    mockCheckJobsRateLimit.mockResolvedValue(new Response(null, { status: 429 }))
    const json = vi.fn()

    const response = await POST({ json } as unknown as Request, { params: { id: JOB_ID } })

    expect(response.status).toBe(429)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(USER_ID)
    expect(json).not.toHaveBeenCalled()
    expect(mockConnectDB).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['empty payload', '{}'],
    ['legacy URL/tier payload', JSON.stringify({ url: 'https://evil.example', tier: 'direct-ats' })],
    ['URL/tier spoof beside id', JSON.stringify({ optionId: OPTION_ID, url: 'https://evil.example', tier: 'direct-ats' })],
    ['malformed id', JSON.stringify({ optionId: 'ao1_short' })],
  ])('rejects %s before connecting to the database', async (_name, body) => {
    const response = await POST(request(body), { params: { id: JOB_ID } })

    expect(response.status).toBe(400)
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockRecordApplyClick).not.toHaveBeenCalled()
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns not-found for an unknown/replaced option without telemetry', async () => {
    mockRecordApplyClick.mockResolvedValue(null)

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(mockRecordApplyClick).toHaveBeenCalledWith(USER_ID, JOB_ID, OPTION_ID)
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('returns the account-unavailable contract when deletion owns the write fence', async () => {
    mockRecordApplyClick.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockRecordJobsUserEvent).not.toHaveBeenCalled()
  })

  it('keeps the direct edge to backward-compatible status/telemetry and returns no governance metadata', async () => {
    const response = await POST(request(JSON.stringify({ optionId: OPTION_ID })), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      status: 'apply_clicked',
      created: true,
      transitioned: true,
    })
    expect(mockRecordJobsUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'jobs.apply_click',
      userId: USER_ID,
      jobPostingId: JOB_ID,
      props: { tier: 'employer', source: 'detail', transitioned: true },
    }))
  })
})
