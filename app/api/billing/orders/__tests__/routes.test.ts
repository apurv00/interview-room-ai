import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OneTimeCheckoutError,
  type OneTimeCheckoutResult,
} from '@payments/services/oneTimeCheckoutService'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  checkBillingRouteRateLimit: vi.fn(),
  createOneTimeCheckout: vi.fn(),
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
  '@payments/services/oneTimeCheckoutService',
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import('@payments/services/oneTimeCheckoutService')
    >(),
    createOneTimeCheckout:
      mocks.createOneTimeCheckout,
  }),
)

vi.mock(
  '@/app/api/_lib/commercialFunnelAnalyticsComposition',
  () => ({
    mintCheckoutObservation: mocks.mintCheckoutObservation,
  }),
)

import { POST as createInterviewOrder } from '../interview/route'
import { POST as createResumeOrder } from '../resume/route'

const userId = '000000000000000000000101'
const intentId = '000000000000000000000102'

function request(
  path: 'interview' | 'resume',
  input?: {
    body?: string
    contentType?: string
    contentLength?: string
    idempotencyKey?: string | null
  },
) {
  return new NextRequest(
    `http://localhost/api/billing/orders/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': input?.contentType ?? 'application/json',
        ...(input?.idempotencyKey === null
          ? {}
          : {
              'Idempotency-Key':
                input?.idempotencyKey ?? 'one-time:attempt-1',
            }),
        ...(input?.contentLength === undefined
          ? {}
          : { 'Content-Length': input.contentLength }),
      },
      body: input?.body ?? JSON.stringify({}),
    },
  )
}

function checkoutResult(
  sku: 'single_interview' | 'premium_resume',
  reused = false,
): OneTimeCheckoutResult {
  return {
    intentId,
    providerMode: 'test',
    intentStatus: 'remote_created',
    reused,
    checkout: {
      keyId: 'rzp_test_public',
      orderId: 'order_checkout_1',
    },
    quote: {
      quoteId: `quote-${sku}`,
      expiresAt: '2026-07-25T12:00:00.000Z',
      catalogVersion: 'consumer-inr-v1',
      sku,
      currency: 'INR',
      gstInclusive: true,
      gstRatePercent: 18,
      listPricePaise: sku === 'single_interview' ? 6_900 : 2_900,
      discountPaise: 0,
      payablePaise: sku === 'single_interview' ? 6_900 : 2_900,
      disclosure: {
        summary: 'One-time purchase.',
        why: 'No coupon applies.',
        gst: 'GST included.',
      },
      entitlementSummary: {
        kind: sku,
      },
    },
  }
}

describe('one-time Razorpay Order routes', () => {
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
    mocks.createOneTimeCheckout
      .mockReset()
      .mockResolvedValue(checkoutResult('single_interview'))
    mocks.mintCheckoutObservation.mockReset().mockResolvedValue(null)
    mocks.loggerError.mockReset()
  })

  it('authenticates before rate limiting or reading request data', async () => {
    mocks.getServerSession.mockResolvedValue(null)

    const response = await createInterviewOrder(request('interview', {
      contentType: 'text/plain',
      body: 'must-not-be-read',
    }))

    expect(response.status).toBe(401)
    expect(mocks.checkBillingRouteRateLimit).not.toHaveBeenCalled()
    expect(
      mocks.createOneTimeCheckout,
    ).not.toHaveBeenCalled()
  })

  it('rate limits before reading request data', async () => {
    mocks.checkBillingRouteRateLimit.mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 19,
    })

    const response = await createResumeOrder(request('resume', {
      contentType: 'text/plain',
      body: 'must-not-be-read',
    }))

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('19')
    expect(mocks.checkBillingRouteRateLimit).toHaveBeenCalledWith({
      userId,
      scope: 'checkout',
    })
    expect(
      mocks.createOneTimeCheckout,
    ).not.toHaveBeenCalled()
  })

  it('creates only the server-selected interview SKU', async () => {
    const response = await createInterviewOrder(request('interview'))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(
      mocks.createOneTimeCheckout,
    ).toHaveBeenCalledWith({
      userId,
      idempotencyKey: 'one-time:attempt-1',
      request: { sku: 'single_interview' },
    }, { createIntent: expect.any(Function) })
    expect(await response.json()).toEqual(
      checkoutResult('single_interview'),
    )
  })

  it('creates a premium-resume order only for the supplied resume target', async () => {
    mocks.createOneTimeCheckout.mockResolvedValue(
      checkoutResult('premium_resume'),
    )

    const response = await createResumeOrder(request('resume', {
      body: JSON.stringify({ resumeId: '  resume-owned-1  ' }),
    }))

    expect(response.status).toBe(201)
    expect(
      mocks.createOneTimeCheckout,
    ).toHaveBeenCalledWith({
      userId,
      idempotencyKey: 'one-time:attempt-1',
      request: {
        sku: 'premium_resume',
        resumeId: 'resume-owned-1',
      },
    }, { createIntent: expect.any(Function) })
    expect(await response.json()).toEqual(
      checkoutResult('premium_resume'),
    )
  })

  it.each([
    ['interview', { pricePaise: 1 }],
    ['interview', { coupon: 'FREE' }],
    ['interview', { providerMode: 'live' }],
    ['resume', { resumeId: 'resume-1', pricePaise: 1 }],
    ['resume', { resumeId: 'resume-1', coupon: 'FREE' }],
    ['resume', { resumeId: 'resume-1', providerMode: 'live' }],
    ['resume', {}],
  ] as const)(
    'rejects client commercial controls on the %s route',
    async (path, body) => {
      const response = path === 'interview'
        ? await createInterviewOrder(request(path, {
            body: JSON.stringify(body),
          }))
        : await createResumeOrder(request(path, {
            body: JSON.stringify(body),
          }))

      expect(response.status).toBe(400)
      expect(
        mocks.createOneTimeCheckout,
      ).not.toHaveBeenCalled()
    },
  )

  it('requires JSON, a bounded body, and a valid Idempotency-Key', async () => {
    let response = await createInterviewOrder(request('interview', {
      contentType: 'text/plain',
    }))
    expect(response.status).toBe(415)

    response = await createInterviewOrder(request('interview', {
      contentLength: '513',
    }))
    expect(response.status).toBe(413)

    response = await createInterviewOrder(request('interview', {
      idempotencyKey: null,
    }))
    expect(response.status).toBe(400)

    response = await createInterviewOrder(request('interview', {
      idempotencyKey: 'short',
    }))
    expect(response.status).toBe(400)
    expect(
      mocks.createOneTimeCheckout,
    ).not.toHaveBeenCalled()
  })

  it('returns 200 when the Order checkout is idempotently reused', async () => {
    mocks.createOneTimeCheckout.mockResolvedValue(
      checkoutResult('single_interview', true),
    )

    const response = await createInterviewOrder(request('interview'))

    expect(response.status).toBe(200)
  })

  it('returns the exact Order checkout when analytics minting fails', async () => {
    mocks.mintCheckoutObservation.mockRejectedValue(
      new Error('analytics unavailable'),
    )

    const response = await createInterviewOrder(request('interview'))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual(
      checkoutResult('single_interview'),
    )
  })

  it('serializes only the public checkout contract', async () => {
    const result = checkoutResult('single_interview') as OneTimeCheckoutResult & {
      buyerSnapshot: { email: string }
      quote: OneTimeCheckoutResult['quote'] & {
        internalCampaign: string
      }
    }
    result.buyerSnapshot = { email: 'private@example.com' }
    result.quote.internalCampaign = 'internal-only'
    mocks.createOneTimeCheckout.mockResolvedValue(result)

    const response = await createInterviewOrder(request('interview'))
    const body = await response.json()

    expect(body).toEqual(checkoutResult('single_interview'))
    expect(JSON.stringify(body)).not.toContain('private@example.com')
    expect(JSON.stringify(body)).not.toContain('internal-only')
  })

  it.each([
    ['invalid_request', 400],
    ['resume_unavailable', 404],
    ['billing_profile_required', 422],
    ['idempotency_conflict', 409],
    ['review_required', 409],
    ['persistence_conflict', 409],
    ['sale_blocked', 503],
    ['buyer_unavailable', 503],
    ['commercial_unavailable', 503],
    ['provider_unavailable', 503],
  ] as const)(
    'maps %s without exposing service details',
    async (code, expectedStatus) => {
      const sensitive = `${userId}:secret-commercial-state`
      mocks.createOneTimeCheckout.mockRejectedValue(
        new OneTimeCheckoutError(code, sensitive),
      )

      const response = await createInterviewOrder(request('interview'))
      const body = await response.json()

      expect(response.status).toBe(expectedStatus)
      expect(JSON.stringify(body)).not.toContain(sensitive)
      expect(JSON.stringify(mocks.loggerError.mock.calls))
        .not.toContain(sensitive)
      expect(JSON.stringify(mocks.loggerError.mock.calls))
        .not.toContain(userId)
    },
  )

  it('keeps the disabled sale gate retryable', async () => {
    mocks.createOneTimeCheckout.mockRejectedValue(
      new OneTimeCheckoutError(
        'sale_blocked',
        'PR7 checkout is disabled',
        { saleBlockReason: 'remote_creation_not_ready' },
      ),
    )

    const response = await createInterviewOrder(request('interview'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.json()).toEqual({
      error: 'One-time checkout is temporarily unavailable',
    })
  })
})
