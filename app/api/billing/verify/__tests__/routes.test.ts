import mongoose from 'mongoose'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  verifyCapturedCheckout: vi.fn(),
  verifyTrustedSubscriptionCheckout: vi.fn(),
  checkBillingRouteRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 10,
    remaining: 9,
    retryAfterSeconds: 0,
  }),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      warn: mocks.loggerWarn,
      error: mocks.loggerError,
    }),
  },
}))

vi.mock('@payments/services/billingRouteRateLimitService', () => ({
  checkBillingRouteRateLimit: mocks.checkBillingRouteRateLimit,
}))

vi.mock(
  '@payments/services/capturedCheckoutVerificationService',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import(
        '@payments/services/capturedCheckoutVerificationService'
      )
    >()
    return {
      ...actual,
      verifyCapturedCheckout: mocks.verifyCapturedCheckout,
    }
  },
)

vi.mock(
  '@payments/services/subscriptionLifecycleService',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import(
        '@payments/services/subscriptionLifecycleService'
      )
    >()
    return {
      ...actual,
      verifyTrustedSubscriptionCheckout:
        mocks.verifyTrustedSubscriptionCheckout,
    }
  },
)

import {
  CapturedCheckoutVerificationError,
} from '@payments/services/capturedCheckoutVerificationService'
import { POST as verifyOrder } from '../order/route'
import { POST as verifySubscription } from '../subscription/route'

const userId = new mongoose.Types.ObjectId().toString()
const intentId = new mongoose.Types.ObjectId().toString()
const validBody = {
  intentId,
  razorpayPaymentId: 'pay_TestPayment123',
  razorpaySignature: 'a'.repeat(64),
}

function request(
  pathname: string,
  body: unknown = validBody,
  contentType = 'application/json',
) {
  return new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(body),
  })
}

describe('customer checkout verification routes', () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset().mockResolvedValue({
      user: { id: userId },
    })
    mocks.verifyCapturedCheckout.mockReset().mockResolvedValue({
      intentId,
      providerMode: 'test',
      razorpayPaymentId: validBody.razorpayPaymentId,
      checkoutKind: 'order',
      fulfillmentKind: 'single_interview',
      intentStatus: 'payment_captured',
      fulfillmentId: new mongoose.Types.ObjectId().toString(),
      fulfillmentStatus: 'verified',
      reused: false,
    })
    mocks.verifyTrustedSubscriptionCheckout
      .mockReset()
      .mockResolvedValue({
        flow: 'acquisition',
        result: {
          intentId,
          providerMode: 'test',
          razorpayPaymentId: validBody.razorpayPaymentId,
          checkoutKind: 'subscription',
          fulfillmentKind: 'subscription_cycle',
          intentStatus: 'payment_captured',
          fulfillmentId: new mongoose.Types.ObjectId().toString(),
          fulfillmentStatus: 'verified',
          reused: false,
        },
      })
    mocks.loggerWarn.mockReset()
    mocks.loggerError.mockReset()
  })

  it('requires an authenticated user before parsing the callback', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await verifyOrder(
      request('/api/billing/verify/order', 'not-json', 'text/plain'),
    )
    expect(response.status).toBe(401)
    expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
  })

  it('passes only validated order callback fields plus server identity', async () => {
    const response = await verifyOrder(
      request('/api/billing/verify/order'),
    )
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe(
      'no-store, private',
    )
    expect(await response.json()).toEqual({
      intentId,
      paymentStatus: 'captured',
      status: 'processing',
      pollAfterMs: 2_000,
    })
    expect(mocks.verifyCapturedCheckout).toHaveBeenCalledWith(
      {
        userId,
        intentId,
        razorpayPaymentId: validBody.razorpayPaymentId,
        signature: validBody.razorpaySignature,
        expectedKind: 'order',
      },
      {
        commercialAnalyticsProducer: expect.objectContaining({
          appendCapturedInSession: expect.any(Function),
        }),
      },
    )
  })

  it('defers subscription completion to the verified webhook authority', async () => {
    const response = await verifySubscription(
      request('/api/billing/verify/subscription'),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      intentId,
      paymentStatus: 'captured',
      status: 'processing',
      pollAfterMs: 2_000,
    })
    expect(response.headers.get('retry-after')).toBe('2')
    expect(mocks.verifyTrustedSubscriptionCheckout).not.toHaveBeenCalled()
    expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
  })

  it('keeps auth, rate limiting, and body validation on deferred callbacks', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)
    const unauthorized = await verifySubscription(
      request('/api/billing/verify/subscription'),
    )
    expect(unauthorized.status).toBe(401)

    const malformed = await verifySubscription(
      request('/api/billing/verify/subscription', {
        ...validBody,
        amount: 599,
      }),
    )
    expect(malformed.status).toBe(400)

    mocks.checkBillingRouteRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 17,
    })
    const limited = await verifySubscription(
      request('/api/billing/verify/subscription'),
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('17')
    expect(mocks.verifyTrustedSubscriptionCheckout).not.toHaveBeenCalled()
    expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...validBody, amount: 6_900 }],
    [{
      ...validBody,
      razorpayOrderId: 'order_browser_supplied',
    }],
    [{ ...validBody, intentId: 'bad' }],
  ])('rejects untrusted or malformed callback data', async (body) => {
    const response = await verifyOrder(
      request('/api/billing/verify/order', body),
    )
    expect(response.status).toBe(400)
    expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
  })

  it.each(['text/plain', 'application/jsonp', ''])(
    'requires an exact JSON media type instead of %s',
    async (contentType) => {
      const response = await verifyOrder(
        request('/api/billing/verify/order', validBody, contentType),
      )
      expect(response.status).toBe(415)
      expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
    },
  )

  it('accepts a JSON charset and rejects an oversized body', async () => {
    let response = await verifyOrder(
      request(
        '/api/billing/verify/order',
        validBody,
        'application/json; charset=utf-8',
      ),
    )
    expect(response.status).toBe(202)

    mocks.verifyCapturedCheckout.mockClear()
    response = await verifyOrder(
      request('/api/billing/verify/order', {
        ...validBody,
        padding: 'x'.repeat(2_048),
      }),
    )
    expect(response.status).toBe(413)
    expect(mocks.verifyCapturedCheckout).not.toHaveBeenCalled()
  })

  it('returns a retryable pending response while capture is incomplete', async () => {
    mocks.verifyCapturedCheckout.mockRejectedValue(
      new CapturedCheckoutVerificationError(
        'payment_capture_pending',
        'provider detail that must not leak',
      ),
    )
    const response = await verifyOrder(
      request('/api/billing/verify/order'),
    )
    expect(response.status).toBe(202)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await response.json()).toEqual({
      paymentStatus: 'pending',
      status: 'awaiting_capture',
      pollAfterMs: 7_000,
    })
  })

  it.each([
    ['signature_invalid', 400, 'Unable to verify checkout'],
    ['intent_not_found', 404, 'Checkout intent not found'],
    ['payment_failed', 409, 'Checkout requires review'],
    ['payment_reversed', 409, 'Checkout requires review'],
    ['payment_not_captured', 409, 'Checkout requires review'],
    ['payment_amount_mismatch', 409, 'Checkout requires review'],
    [
      'provider_unavailable',
      503,
      'Checkout verification is temporarily unavailable',
    ],
  ] as const)(
    'maps %s without exposing provider details',
    async (code, expectedStatus, expectedError) => {
      mocks.verifyCapturedCheckout.mockRejectedValue(
        new CapturedCheckoutVerificationError(
          code,
          'sensitive provider detail',
        ),
      )
      const response = await verifyOrder(
        request('/api/billing/verify/order'),
      )
      expect(response.status).toBe(expectedStatus)
      expect(await response.json()).toEqual({ error: expectedError })
      if (expectedStatus === 503) {
        expect(response.headers.get('retry-after')).toBe('5')
      } else if (expectedStatus === 409) {
        expect(response.headers.get('retry-after')).toBeNull()
      }
      expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
        userId,
      )
      expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
        'sensitive provider detail',
      )
    },
  )

  it('sanitizes unexpected failures in both the response and logs', async () => {
    mocks.verifyCapturedCheckout.mockRejectedValue(
      new Error(
        'secret buyer@example.com pay_PrivateProviderPayment',
      ),
    )

    const response = await verifyOrder(
      request('/api/billing/verify/order'),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.json()).toEqual({
      error: 'Checkout verification is temporarily unavailable',
    })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        errorName: 'Error',
        expectedKind: 'order',
      },
      'Checkout verification failed unexpectedly',
    )
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(userId)
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      'buyer@example.com',
    )
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      'pay_PrivateProviderPayment',
    )
  })

  it('never trusts a browser callback to produce a terminal subscription result', async () => {
    mocks.verifyTrustedSubscriptionCheckout.mockResolvedValue({
      flow: 'acquisition',
      result: {
        intentId,
        providerMode: 'live',
        razorpayPaymentId: 'pay_PrivateProviderPayment',
        fulfillmentId: new mongoose.Types.ObjectId().toString(),
        intentStatus: 'review',
        fulfillmentStatus: 'review',
      },
    })

    const response = await verifySubscription(
      request('/api/billing/verify/subscription'),
    )

    expect(response.status).toBe(202)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.json()).toEqual({
      intentId,
      paymentStatus: 'captured',
      status: 'processing',
      pollAfterMs: 2_000,
    })
    expect(mocks.verifyTrustedSubscriptionCheckout).not.toHaveBeenCalled()
  })

  it('returns only terminal public status when fulfillment is done', async () => {
    mocks.verifyCapturedCheckout.mockResolvedValue({
      intentId,
      intentStatus: 'fulfilled',
      fulfillmentStatus: 'done',
    })
    const response = await verifyOrder(
      request('/api/billing/verify/order'),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      intentId,
      paymentStatus: 'captured',
      status: 'completed',
    })
  })
})
