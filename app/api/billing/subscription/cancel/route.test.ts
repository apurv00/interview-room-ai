import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn() }),
  },
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
      initiateCustomerPeriodEndCancellation: mocks.cancel,
    }
  },
)

import { POST } from './route'

const USER_ID = '507f1f77bcf86cd799439001'

function request(body: string = '{"confirmPeriodEnd":true}') {
  return new NextRequest(
    'http://localhost/api/billing/subscription/cancel',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'billing-cancel:route-1',
      },
      body,
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.cancel.mockResolvedValue({
    planChangeRequestId: '507f1f77bcf86cd799439005',
    status: 'scheduled',
    effectiveAt: '2026-09-05T11:00:00.000Z',
    reused: false,
  })
})

describe('POST /api/billing/subscription/cancel', () => {
  it('binds cancellation to the authenticated user and idempotency key', async () => {
    const response = await POST(request())

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(mocks.cancel).toHaveBeenCalledWith({
      userId: USER_ID,
      idempotencyKey: 'billing-cancel:route-1',
    })
  })

  it('rejects unauthenticated and malformed requests', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)
    expect((await POST(request())).status).toBe(401)

    expect((await POST(request('{"confirmPeriodEnd":false}'))).status)
      .toBe(400)
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
})
