import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(),
  createFuture: vi.fn(),
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
  '@payments/services/subscriptionCheckoutService',
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import('@payments/services/subscriptionCheckoutService')
    >()
    return {
      ...original,
      createFutureSubscriptionCheckout: mocks.createFuture,
    }
  },
)

import { POST } from './route'

const USER_ID = '507f1f77bcf86cd799439001'
const CHANGE_ID = '507f1f77bcf86cd799439005'

function request(body: object) {
  return new NextRequest(
    'http://localhost/api/billing/subscriptions/checkout/future',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'billing-future:route-1',
      },
      body: JSON.stringify(body),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.createFuture.mockResolvedValue({
    intentId: '507f1f77bcf86cd799439006',
    reused: false,
  })
})

describe('POST /api/billing/subscriptions/checkout/future', () => {
  it('reopens a trusted future checkout with customer idempotency', async () => {
    const response = await POST(request({ planChangeRequestId: CHANGE_ID }))

    expect(response.status).toBe(201)
    expect(mocks.createFuture).toHaveBeenCalledWith({
      userId: USER_ID,
      idempotencyKey: 'billing-future:route-1',
      planChangeRequestId: CHANGE_ID,
    })
  })

  it('rejects untrusted economics in the request body', async () => {
    const response = await POST(request({
      planChangeRequestId: CHANGE_ID,
      amountPaise: 500,
    }))

    expect(response.status).toBe(400)
    expect(mocks.createFuture).not.toHaveBeenCalled()
  })
})
