import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  receiveRazorpayWebhook: vi.fn(),
  processPaymentWebhookEvent: vi.fn(),
  paymentWebhookLaunchHandler: vi.fn(),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      error: mocks.loggerError,
    }),
  },
}))

vi.mock('@payments/services/webhookInboxService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@payments/services/webhookInboxService')
  >()
  return {
    ...actual,
    receiveRazorpayWebhook: mocks.receiveRazorpayWebhook,
  }
})

vi.mock(
  '@payments/services/webhookProcessingService',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@payments/services/webhookProcessingService')
    >()
    return {
      ...actual,
      processPaymentWebhookEvent: mocks.processPaymentWebhookEvent,
    }
  },
)

vi.mock('@/app/api/_lib/paymentWebhookLaunchComposition', () => ({
  paymentWebhookLaunchHandler: mocks.paymentWebhookLaunchHandler,
}))

import { POST } from '../route'

const testWebhookSecret = 'test-mode-webhook-secret'
const liveWebhookSecret = 'live-mode-webhook-secret'
const rawBody = Buffer.from(JSON.stringify({
  entity: 'event',
  event: 'payment.captured',
  contains: ['payment'],
  payload: { payment: { entity: { id: 'pay_test_1' } } },
}))

function sign(body: Uint8Array, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function request(input: {
  body?: Uint8Array
  signature?: string
  eventId?: string
  contentLength?: string
} = {}) {
  const body = input.body ?? rawBody
  const headers = new Headers({
    'Content-Type': 'application/json',
  })
  if (input.signature !== undefined) {
    headers.set('X-Razorpay-Signature', input.signature)
  }
  if (input.eventId !== undefined) {
    headers.set('X-Razorpay-Event-Id', input.eventId)
  }
  if (input.contentLength !== undefined) {
    headers.set('Content-Length', input.contentLength)
  }
  return new NextRequest(
    'http://localhost/api/billing/webhooks/razorpay',
    {
      method: 'POST',
      headers,
      body,
    },
  )
}

describe('Razorpay webhook route', () => {
  beforeEach(() => {
    mocks.loggerError.mockReset()
    mocks.receiveRazorpayWebhook.mockReset().mockResolvedValue({
      id: 'inbox-1',
      duplicate: false,
      eventType: 'payment.captured',
      supported: true,
    })
    mocks.processPaymentWebhookEvent.mockReset().mockResolvedValue({
      outcome: 'processed',
      eventType: 'payment.captured',
      attempts: 1,
    })
    mocks.paymentWebhookLaunchHandler.mockReset()
    delete process.env.RAZORPAY_TEST_WEBHOOK_SECRET
    delete process.env.RAZORPAY_TEST_WEBHOOK_PREVIOUS_SECRET
    delete process.env.RAZORPAY_LIVE_WEBHOOK_SECRET
    delete process.env.RAZORPAY_LIVE_WEBHOOK_PREVIOUS_SECRET
    process.env.PAYMENT_WEBHOOK_PAYLOAD_KEY_BASE64 =
      Buffer.alloc(32, 2).toString('base64')
    process.env.PAYMENT_WEBHOOK_PAYLOAD_KEY_VERSION = 'test-key-v1'
  })

  afterEach(() => {
    delete process.env.RAZORPAY_TEST_WEBHOOK_SECRET
    delete process.env.RAZORPAY_TEST_WEBHOOK_PREVIOUS_SECRET
    delete process.env.RAZORPAY_LIVE_WEBHOOK_SECRET
    delete process.env.RAZORPAY_LIVE_WEBHOOK_PREVIOUS_SECRET
    delete process.env.PAYMENT_WEBHOOK_PAYLOAD_KEY_BASE64
    delete process.env.PAYMENT_WEBHOOK_PAYLOAD_KEY_VERSION
  })

  it('requires the provider signature header', async () => {
    const response = await POST(request())
    expect(response.status).toBe(400)
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()
  })

  it('rejects declared and streamed oversized bodies before verification', async () => {
    const declared = await POST(request({
      body: rawBody,
      signature: sign(rawBody, testWebhookSecret),
      contentLength: String(1_048_577),
    }))
    expect(declared.status).toBe(413)
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()

    const oversizedBody = Buffer.alloc(1_048_577, 1)
    const streamed = await POST(request({
      body: oversizedBody,
      signature: sign(oversizedBody, testWebhookSecret),
    }))
    expect(streamed.status).toBe(413)
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()
  })

  it('stays not-ready when no provider mode is configured', async () => {
    const response = await POST(request({
      signature: sign(rawBody, testWebhookSecret),
    }))
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()
  })

  it('infers test mode only after HMAC verification and passes exact bytes', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    const response = await POST(request({
      signature: sign(rawBody, testWebhookSecret),
      eventId: 'evt_test_1',
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      received: true,
      duplicate: false,
    })
    expect(mocks.receiveRazorpayWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'test',
        rawBody,
        signature: sign(rawBody, testWebhookSecret),
        razorpayEventId: 'evt_test_1',
        signingSecrets: [
          { version: 'current', value: testWebhookSecret },
        ],
      }),
    )
    expect(mocks.processPaymentWebhookEvent).toHaveBeenCalledWith({
      eventId: 'inbox-1',
      handler: mocks.paymentWebhookLaunchHandler,
    })
  })

  it('acknowledges only processed or already-processed inbox rows', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    mocks.receiveRazorpayWebhook.mockResolvedValue({
      id: 'inbox-duplicate',
      duplicate: true,
      eventType: 'payment.captured',
      supported: true,
    })
    mocks.processPaymentWebhookEvent.mockResolvedValue({
      outcome: 'already_processed',
      attempts: 1,
    })

    const response = await POST(request({
      signature: sign(rawBody, testWebhookSecret),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      received: true,
      duplicate: true,
    })
  })

  it.each(['failed', 'busy', 'claim_lost', 'not_found'] as const)(
    'returns a retryable failure when processing is %s',
    async (outcome) => {
      process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
      mocks.processPaymentWebhookEvent.mockResolvedValue({
        outcome,
        attempts: outcome === 'not_found' ? 0 : 1,
        ...(outcome === 'failed' ? { willRetry: true } : {}),
      })

      const response = await POST(request({
        signature: sign(rawBody, testWebhookSecret),
      }))

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('10')
      expect(await response.json()).toEqual({
        error: 'Webhook processing is temporarily unavailable',
      })
      expect(mocks.loggerError).toHaveBeenCalledWith(
        {
          providerMode: 'test',
          processingOutcome: outcome,
        },
        'Razorpay webhook was stored but not completed',
      )
    },
  )

  it('does not acknowledge a dead-lettered inbox row', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    mocks.processPaymentWebhookEvent.mockResolvedValue({
      outcome: 'dead_letter',
      attempts: 8,
    })

    const response = await POST(request({
      signature: sign(rawBody, testWebhookSecret),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Webhook requires review',
    })
  })

  it('rejects a signature that matches no configured mode', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    const response = await POST(request({
      signature: sign(rawBody, 'wrong-secret'),
    }))
    expect(response.status).toBe(401)
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()
  })

  it('fails closed when test and live secrets make mode ambiguous', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    process.env.RAZORPAY_LIVE_WEBHOOK_SECRET = testWebhookSecret
    const response = await POST(request({
      signature: sign(rawBody, testWebhookSecret),
    }))
    expect(response.status).toBe(503)
    expect(mocks.receiveRazorpayWebhook).not.toHaveBeenCalled()
  })

  it('keeps live and test signature domains distinct', async () => {
    process.env.RAZORPAY_TEST_WEBHOOK_SECRET = testWebhookSecret
    process.env.RAZORPAY_LIVE_WEBHOOK_SECRET = liveWebhookSecret
    const response = await POST(request({
      signature: sign(rawBody, liveWebhookSecret),
    }))
    expect(response.status).toBe(200)
    expect(mocks.receiveRazorpayWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'live',
        signingSecrets: [
          { version: 'current', value: liveWebhookSecret },
        ],
      }),
    )
  })

  it('exposes only the exact webhook path through middleware', () => {
    const middlewareSource = readFileSync(
      path.join(process.cwd(), 'middleware.ts'),
      'utf8',
    )
    expect(middlewareSource).toContain(
      "pathname === '/api/billing/webhooks/razorpay'",
    )
    expect(middlewareSource).not.toContain(
      "pathname.startsWith('/api/billing')",
    )
    expect(middlewareSource).not.toContain(
      "pathname.startsWith('/api/billing/webhooks')",
    )
  })
})
