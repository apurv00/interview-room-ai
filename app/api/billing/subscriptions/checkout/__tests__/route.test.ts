import mongoose from 'mongoose'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SubscriptionCheckoutError,
} from '@payments/services/subscriptionCheckoutService'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  checkBillingRouteRateLimit: vi.fn(),
  createSubscriptionCheckout: vi.fn(),
  mintCheckoutObservation: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      error: mocks.loggerError,
    }),
  },
}))

vi.mock('@payments/services/billingRouteRateLimitService', () => ({
  checkBillingRouteRateLimit: mocks.checkBillingRouteRateLimit,
}))

vi.mock(
  '@payments/services/subscriptionCheckoutService',
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import('@payments/services/subscriptionCheckoutService')
    >(),
    createSubscriptionCheckout:
      mocks.createSubscriptionCheckout,
  }),
)

vi.mock(
  '@/app/api/_lib/commercialFunnelAnalyticsComposition',
  () => ({
    mintCheckoutObservation: mocks.mintCheckoutObservation,
  }),
)

import { POST } from '../route'

const userId = new mongoose.Types.ObjectId().toString()
const intentId = new mongoose.Types.ObjectId().toString()
const campaignId = new mongoose.Types.ObjectId().toString()

function request(input?: {
  body?: string
  contentType?: string
  idempotencyKey?: string
  contentLength?: string
}) {
  return new NextRequest(
    'http://localhost/api/billing/subscriptions/checkout',
    {
      method: 'POST',
      headers: {
        'Content-Type': input?.contentType ?? 'application/json',
        ...(input?.idempotencyKey === null
          ? {}
          : {
              'Idempotency-Key':
                input?.idempotencyKey ?? 'checkout:attempt-1',
            }),
        ...(input?.contentLength
          ? { 'Content-Length': input.contentLength }
          : {}),
      },
      body: input?.body ?? JSON.stringify({ planKey: 'plus' }),
    },
  )
}

function checkoutResult(reused = false) {
  return {
    intentId,
    providerMode: 'test' as const,
    intentStatus: 'remote_created' as const,
    reused,
    checkout: {
      keyId: 'rzp_test_public',
      subscriptionId: 'sub_checkout_1',
    },
    quote: {
      catalogVersion: 'consumer-inr-v1',
      planKey: 'plus' as const,
      currency: 'INR' as const,
      gstInclusive: true as const,
      gstRatePercent: 18 as const,
      listPricePaise: 59_900,
      discountPaise: 10_000,
      payablePaise: 49_900,
      nextChargePaise: 59_900,
      renewalPricePaise: 59_900,
      discountedBillingCycles: 1,
      coupon: {
        campaignId,
        revision: 2,
        mode: 'automatic' as const,
        displayText: '₹100 off',
        termsText: 'Applies to the first paid billing cycle.',
      },
      renewalSchedule: {
        cadence: 'monthly' as const,
        status: 'pending_authorization' as const,
        scheduledAt: null,
      },
      disclosure: {
        summary: '₹499 first month, then ₹599/month.',
        why: 'Best eligible automatic offer applied.',
        terms: 'Applies to the first paid billing cycle.',
        gst: 'GST included.' as const,
        cancellation: 'Auto-renews until cancelled.' as const,
      },
      entitlementSummary: {},
    },
  }
}

describe('POST /api/billing/subscriptions/checkout', () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset().mockResolvedValue({
      user: { id: userId },
    })
    mocks.checkBillingRouteRateLimit.mockReset().mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfterSeconds: 0,
    })
    mocks.createSubscriptionCheckout
      .mockReset()
      .mockResolvedValue(checkoutResult())
    mocks.mintCheckoutObservation.mockReset().mockResolvedValue(null)
    mocks.loggerError.mockReset()
  })

  it('authenticates before rate limiting or reading checkout data', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await POST(request({
      contentType: 'text/plain',
      body: 'must-not-be-read',
    }))

    expect(response.status).toBe(401)
    expect(mocks.checkBillingRouteRateLimit).not.toHaveBeenCalled()
    expect(
      mocks.createSubscriptionCheckout,
    ).not.toHaveBeenCalled()
  })

  it('rate limits before parsing the body', async () => {
    mocks.checkBillingRouteRateLimit.mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 23,
    })
    const response = await POST(request({
      contentType: 'text/plain',
      body: 'must-not-be-read',
    }))

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('23')
    expect(mocks.checkBillingRouteRateLimit).toHaveBeenCalledWith({
      userId,
      scope: 'checkout',
    })
    expect(
      mocks.createSubscriptionCheckout,
    ).not.toHaveBeenCalled()
  })

  it('requires JSON, a bounded body, and an Idempotency-Key', async () => {
    let response = await POST(request({ contentType: 'text/plain' }))
    expect(response.status).toBe(415)

    response = await POST(request({ contentLength: '513' }))
    expect(response.status).toBe(413)

    response = await POST(request({ idempotencyKey: null as never }))
    expect(response.status).toBe(400)
    expect(
      mocks.createSubscriptionCheckout,
    ).not.toHaveBeenCalled()
  })

  it('normalizes the manual code and returns a new checkout with no-store', async () => {
    const response = await POST(request({
      body: JSON.stringify({
        planKey: 'plus',
        manualCouponCode: ' launch100 ',
      }),
    }))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(
      mocks.createSubscriptionCheckout,
    ).toHaveBeenCalledWith({
      userId,
      idempotencyKey: 'checkout:attempt-1',
      request: {
        planKey: 'plus',
        manualCouponCode: 'LAUNCH100',
      },
    }, { createIntent: expect.any(Function) })
    expect(await response.json()).toEqual(checkoutResult())
  })

  it('returns 200 for an idempotently reused checkout', async () => {
    mocks.createSubscriptionCheckout.mockResolvedValue(
      checkoutResult(true),
    )
    const response = await POST(request())
    expect(response.status).toBe(200)
  })

  it('returns the exact checkout when analytics minting fails', async () => {
    mocks.mintCheckoutObservation.mockRejectedValue(
      new Error('analytics unavailable'),
    )

    const response = await POST(request())

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual(checkoutResult())
  })

  it('maps selection conflicts to 409', async () => {
    mocks.createSubscriptionCheckout.mockRejectedValue(
      new SubscriptionCheckoutError(
        'idempotency_conflict',
        'sensitive internal detail',
      ),
    )
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Subscription checkout conflict',
    })
  })

  it('maps a missing billing state to a customer-correctable response', async () => {
    mocks.createSubscriptionCheckout.mockRejectedValue(
      new SubscriptionCheckoutError(
        'billing_profile_required',
        `${userId}:sensitive profile detail`,
      ),
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(body).toEqual({
      error: 'Add your billing state before checkout',
      code: 'billing_profile_required',
    })
    expect(JSON.stringify(body)).not.toContain(userId)
  })

  it('keeps the disabled sale gate sanitized and retryable', async () => {
    const sensitive = `${userId}:secret:coupon`
    mocks.createSubscriptionCheckout.mockRejectedValue(
      new SubscriptionCheckoutError(
        'sale_blocked',
        sensitive,
        { saleBlockReason: 'remote_creation_not_ready' },
      ),
    )
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(body).toEqual({
      error: 'Subscription checkout is temporarily unavailable',
    })
    expect(JSON.stringify(body)).not.toContain(sensitive)
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain(sensitive)
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain(userId)
  })
})
