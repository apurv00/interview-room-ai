import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  checkBillingRouteRateLimit: vi.fn(),
  resolveCustomerBillingQuote: vi.fn(),
  recordResolvedQuoteFunnel: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      error: mocks.loggerError,
      warn: mocks.loggerError,
    }),
  },
}))

vi.mock('@payments/services/billingRouteRateLimitService', () => ({
  checkBillingRouteRateLimit: mocks.checkBillingRouteRateLimit,
}))

vi.mock(
  '@payments/services/customerBillingQuoteService',
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import('@payments/services/customerBillingQuoteService')
    >(),
    resolveCustomerBillingQuote:
      mocks.resolveCustomerBillingQuote,
  }),
)

vi.mock(
  '@/app/api/_lib/commercialFunnelAnalyticsComposition',
  () => ({
    recordResolvedQuoteFunnel:
      mocks.recordResolvedQuoteFunnel,
  }),
)

import { POST } from '../route'

const userId = '69fb49747e70dc410e5a2f12'

function request(
  body: string,
  contentType = 'application/json',
  extraHeaders: Record<string, string> = {},
) {
  return new NextRequest('http://localhost/api/billing/quote', {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...extraHeaders,
    },
    body,
  })
}

describe('POST /api/billing/quote', () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset().mockResolvedValue({
      user: { id: userId },
    })
    mocks.checkBillingRouteRateLimit.mockReset().mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 0,
    })
    mocks.resolveCustomerBillingQuote.mockReset().mockResolvedValue({
      quote: {
        quoteId: 'quote-safe-id',
        expiresAt: '2026-07-24T12:05:00.000Z',
        catalogVersion: 'consumer-inr-v1',
        planKey: 'plus',
        currency: 'INR',
        gstInclusive: true,
        listPricePaise: 59900,
        discountPaise: 10000,
        payablePaise: 49900,
        entitlementSummary: {},
      },
    })
    mocks.recordResolvedQuoteFunnel.mockReset().mockResolvedValue(
      undefined,
    )
    mocks.loggerError.mockReset()
  })

  it('authenticates before limiting or reading the body', async () => {
    mocks.getServerSession.mockResolvedValue(null)
    const response = await POST(request(
      'body-must-not-be-read',
      'text/plain',
    ))

    expect(response.status).toBe(401)
    expect(mocks.checkBillingRouteRateLimit).not.toHaveBeenCalled()
    expect(mocks.resolveCustomerBillingQuote).not.toHaveBeenCalled()
  })

  it('uses a dedicated fail-closed quote limit before body parsing', async () => {
    mocks.checkBillingRouteRateLimit.mockResolvedValue({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 17,
    })
    const response = await POST(request(
      'body-must-not-be-read',
      'text/plain',
    ))

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(mocks.checkBillingRouteRateLimit).toHaveBeenCalledWith({
      userId,
      scope: 'quote',
    })
    expect(mocks.resolveCustomerBillingQuote).not.toHaveBeenCalled()
  })

  it('returns a private no-store quote and normalizes the manual code', async () => {
    const response = await POST(request(JSON.stringify({
      planKey: 'plus',
      surface: 'pricing',
      manualCouponCode: ' save100 ',
    })))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'no-store, private',
    )
    expect(mocks.resolveCustomerBillingQuote).toHaveBeenCalledWith({
      userId,
      request: {
        planKey: 'plus',
        surface: 'pricing',
        manualCouponCode: 'SAVE100',
      },
    })
    expect(mocks.recordResolvedQuoteFunnel).toHaveBeenCalledWith({
      userId,
      surface: 'pricing',
      manualCodeLength: 7,
      resolved: expect.objectContaining({
        quote: expect.objectContaining({
          quoteId: 'quote-safe-id',
        }),
      }),
    })
  })

  it('rejects client economics and unsupported request bodies', async () => {
    let response = await POST(request(JSON.stringify({
      planKey: 'plus',
      surface: 'pricing',
      amountPaise: 1,
    })))
    expect(response.status).toBe(400)
    expect(mocks.resolveCustomerBillingQuote).not.toHaveBeenCalled()

    response = await POST(request('{}', 'text/plain'))
    expect(response.status).toBe(415)

    response = await POST(request(
      '{}',
      'application/json',
      { 'Content-Length': '1025' },
    ))
    expect(response.status).toBe(413)
  })

  it('sanitizes limiter failures without reading or logging a coupon code', async () => {
    const secretCode = 'PRIVATE_SAVE_200'
    mocks.checkBillingRouteRateLimit.mockRejectedValue(
      new Error(`${userId}:${secretCode}:redis-host`),
    )
    const response = await POST(request(JSON.stringify({
      planKey: 'pro',
      surface: 'pricing',
      manualCouponCode: secretCode,
    })))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(mocks.resolveCustomerBillingQuote).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain(secretCode)
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain(userId)
  })

  it('returns a sanitized temporary failure when quote authority fails', async () => {
    mocks.resolveCustomerBillingQuote.mockRejectedValue(
      new Error('mongodb-host-and-code-SAVE100'),
    )
    const response = await POST(request(JSON.stringify({
      planKey: 'plus',
      surface: 'pricing',
      manualCouponCode: 'SAVE100',
    })))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Billing quote is temporarily unavailable',
    })
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain('SAVE100')
    expect(JSON.stringify(mocks.loggerError.mock.calls))
      .not.toContain('mongodb-host')
  })

  it('keeps the authoritative quote truthful when analytics fails', async () => {
    mocks.recordResolvedQuoteFunnel.mockRejectedValue(
      new Error('analytics unavailable'),
    )

    const response = await POST(request(JSON.stringify({
      planKey: 'plus',
      surface: 'checkout',
    })))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      quoteId: 'quote-safe-id',
      payablePaise: 49900,
    })
  })
})
