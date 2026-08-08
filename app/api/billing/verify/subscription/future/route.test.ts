import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(),
  verifyFuture: vi.fn(),
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
      verifyFutureSubscriptionAuthorization: mocks.verifyFuture,
    }
  },
)

import { POST } from './route'

const USER_ID = '507f1f77bcf86cd799439001'
const INTENT_ID = '507f1f77bcf86cd799439006'
const CHANGE_ID = '507f1f77bcf86cd799439005'

function request() {
  return new NextRequest(
    'http://localhost/api/billing/verify/subscription/future',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intentId: INTENT_ID,
        razorpayPaymentId: 'pay_future123',
        razorpaySignature: 'a'.repeat(64),
      }),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.verifyFuture.mockResolvedValue({
    intentId: INTENT_ID,
    planChangeRequestId: CHANGE_ID,
    status: 'scheduled',
    reused: false,
  })
})

describe('POST /api/billing/verify/subscription/future', () => {
  it('binds mandate verification to the authenticated account', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.verifyFuture).toHaveBeenCalledWith({
      userId: USER_ID,
      intentId: INTENT_ID,
      razorpayPaymentId: 'pay_future123',
      signature: 'a'.repeat(64),
    })
    expect(await response.json()).toMatchObject({ status: 'scheduled' })
  })

  it('rejects unauthenticated verification before provider access', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)

    expect((await POST(request())).status).toBe(401)
    expect(mocks.verifyFuture).not.toHaveBeenCalled()
  })
})
