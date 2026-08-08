import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(),
  cancelScheduled: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('@payments/services/billingRouteRateLimitService', () => ({
  checkBillingRouteRateLimit: mocks.rateLimit,
}))
vi.mock(
  '@payments/services/subscriptionLifecycleService',
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import('@payments/services/subscriptionLifecycleService')
    >()
    return {
      ...original,
      cancelCustomerScheduledPlanChange: mocks.cancelScheduled,
    }
  },
)

import { POST } from './route'

const USER_ID = '507f1f77bcf86cd799439001'
const CHANGE_ID = '507f1f77bcf86cd799439005'

function request() {
  return new NextRequest(
    'http://localhost/api/billing/subscription/plan-change/cancel',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `billing-cancel-change:${CHANGE_ID}`,
      },
      body: JSON.stringify({ planChangeRequestId: CHANGE_ID }),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.cancelScheduled.mockResolvedValue({
    planChangeRequestId: CHANGE_ID,
    status: 'cancelled',
    effectiveAt: '2026-09-01T00:00:00.000Z',
    reused: false,
  })
})

describe('POST /api/billing/subscription/plan-change/cancel', () => {
  it('cancels only the authenticated customer request ID', async () => {
    const response = await POST(request())

    expect(response.status).toBe(202)
    expect(mocks.cancelScheduled).toHaveBeenCalledWith({
      userId: USER_ID,
      planChangeRequestId: CHANGE_ID,
    })
  })

  it('rejects unauthenticated cancellation before provider access', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)

    expect((await POST(request())).status).toBe(401)
    expect(mocks.cancelScheduled).not.toHaveBeenCalled()
  })
})
