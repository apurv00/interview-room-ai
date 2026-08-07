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
const CHANGE_ID = '507f1f77bcf86cd799439005'

function request(body: object, idempotencyKey = 'billing-change:route-1') {
  return new NextRequest(
    'http://localhost/api/billing/subscription/plan-change',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
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
    planChangeRequestId: CHANGE_ID,
    effectiveAt: '2026-09-01T00:00:00.000Z',
    checkout: { intentId: '507f1f77bcf86cd799439006' },
    reused: false,
  })
})

describe('POST /api/billing/subscription/plan-change', () => {
  it('binds a tier change to the authenticated user and idempotency key', async () => {
    const response = await POST(request({
      action: 'schedule',
      targetPlanKey: 'pro',
    }))

    expect(response.status).toBe(202)
    expect(mocks.initiate).toHaveBeenCalledWith({
      userId: USER_ID,
      idempotencyKey: 'billing-change:route-1',
      operation: 'tier_change',
      targetPlanKey: 'pro',
    })
  })

  it('keeps scheduled cancellation on its dedicated route', async () => {
    const response = await POST(request({
      action: 'cancel_scheduled',
      planChangeRequestId: CHANGE_ID,
    }))

    expect(response.status).toBe(400)
    expect(mocks.initiate).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests and future-change coupons', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)
    expect((await POST(request({
      action: 'schedule',
      targetPlanKey: 'pro',
    }))).status).toBe(401)

    expect((await POST(request({
      action: 'schedule',
      targetPlanKey: 'pro',
      manualCouponCode: 'GURU100',
    }))).status).toBe(400)
    expect(mocks.initiate).not.toHaveBeenCalled()
  })
})
