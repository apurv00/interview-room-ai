import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckJobsRateLimit,
  mockConnectDB,
  mockGetServerSession,
  mockTransitionStatus,
} = vi.hoisted(() => ({
  mockCheckJobsRateLimit: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetServerSession: vi.fn(),
  mockTransitionStatus: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs/services/rateLimit', () => ({ checkJobsRateLimit: mockCheckJobsRateLimit }))
vi.mock('@jobs', () => ({
  transitionStatus: mockTransitionStatus,
  USER_SETTABLE_STATUSES: [
    'saved',
    'applied',
    'interview_scheduled',
    'offer',
    'rejected',
    'ghosted',
    'withdrawn',
  ],
}))

import { POST } from '../route'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'

function request(status = 'applied', extra: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...extra }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockConnectDB.mockResolvedValue(undefined)
  mockTransitionStatus.mockResolvedValue({ ok: true, status: 'applied', from: 'saved' })
})

describe('POST /api/jobs/[id]/status account fence', () => {
  it('returns the account-unavailable contract when deletion owns the write fence', async () => {
    mockTransitionStatus.mockRejectedValueOnce(new JobsAccountInactiveError(USER_ID))

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('keeps an ordinary missing application distinct from an inactive account', async () => {
    mockTransitionStatus.mockResolvedValueOnce({ ok: false })

    const response = await POST(request(), { params: { id: JOB_ID } })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'no application for this job' })
  })

  it('does not swallow unexpected service failures', async () => {
    mockTransitionStatus.mockRejectedValueOnce(new Error('database failed'))

    await expect(POST(request(), { params: { id: JOB_ID } })).rejects.toThrow('database failed')
  })

  it('passes a validated tailored-resume confirmation to the transaction service', async () => {
    const tailoredAt = '2026-07-14T11:00:00.000Z'
    const response = await POST(request('applied', {
      appliedWith: { wasTailored: true, tailoredAt },
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(200)
    expect(mockTransitionStatus).toHaveBeenCalledWith(
      USER_ID,
      JOB_ID,
      'applied',
      expect.objectContaining({
        appliedWith: { wasTailored: true, tailoredAt: new Date(tailoredAt) },
      }),
    )
  })

  it('rejects malformed or non-applied resume claims before database work', async () => {
    for (const [status, appliedWith] of [
      ['applied', { wasTailored: true }],
      ['saved', { wasTailored: false }],
      ['applied', { wasTailored: 'yes' }],
    ] as const) {
      const response = await POST(request(status, { appliedWith }), { params: { id: JOB_ID } })
      expect(response.status).toBe(400)
    }
    expect(mockConnectDB).not.toHaveBeenCalled()
    expect(mockTransitionStatus).not.toHaveBeenCalled()
  })

  it('maps a stale tailored-version selection to a retryable conflict', async () => {
    mockTransitionStatus.mockResolvedValueOnce({
      ok: false,
      reason: 'tailored-version-unavailable',
    })

    const response = await POST(request('applied', {
      appliedWith: { wasTailored: true, tailoredAt: '2026-07-14T11:00:00.000Z' },
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'TAILORED_VERSION_UNAVAILABLE' })
  })

  it('maps a conflicting same-status resume claim without reporting success', async () => {
    mockTransitionStatus.mockResolvedValueOnce({ ok: false, reason: 'applied-with-conflict' })

    const response = await POST(request('applied', {
      appliedWith: { wasTailored: false },
    }), { params: { id: JOB_ID } })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'APPLIED_WITH_CONFLICT' })
  })
})
