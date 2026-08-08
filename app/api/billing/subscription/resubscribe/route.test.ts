import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(),
  initiate: vi.fn(),
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
      initiateCustomerFuturePlanChange: mocks.initiate,
    }
  },
)

import { POST } from './route'

const USER_ID = '507f1f77bcf86cd799439001'

function request(body: object = {}) {
  return new NextRequest(
    'http://localhost/api/billing/subscription/resubscribe',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'billing-resubscribe:route-1',
      },
      body: JSON.stringify(body),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.initiate.mockResolvedValue({
    planChangeRequestId: '507f1f77bcf86cd799439005',
    effectiveAt: '2026-09-01T00:00:00.000Z',
    checkout: { intentId: '507f1f77bcf86cd799439006' },
    reused: false,
  })
})

describe('POST /api/billing/subscription/resubscribe', () => {
  it('starts same-tier resubscribe with authenticated idempotency', async () => {
    const response = await POST(request())

    expect(response.status).toBe(202)
    expect(mocks.initiate).toHaveBeenCalledWith({
      userId: USER_ID,
      idempotencyKey: 'billing-resubscribe:route-1',
      operation: 'resubscribe',
    })
  })

  it('rejects a coupon instead of silently changing future economics', async () => {
    const response = await POST(request({ manualCouponCode: 'GURU100' }))

    expect(response.status).toBe(400)
    expect(mocks.initiate).not.toHaveBeenCalled()
  })
})
