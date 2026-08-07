import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import {
  encryptWebhookPayload,
  type WebhookPayloadEncryptionKey,
} from '../providers/webhookPayloadCipher'
import type {
  RazorpayInvoiceDto,
  RazorpayPaymentDto,
  RazorpayServerAdapter,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import {
  dispatchVerifiedRazorpayWebhook,
  WebhookDomainDispatchError,
  type PaymentStateEffectInput,
  type TrustedSubscriptionWebhookCheckout,
} from '../services/webhookDomainDispatchService'
import {
  persistPaymentState,
  type PaymentStateAttemptDraft,
  type PaymentStatePersistenceStore,
  type StoredPaymentStateAttempt,
} from '../services/paymentStatePersistenceService'
import {
  processPaymentWebhookEvent,
  type ClaimedPaymentWebhookEvent,
  type PaymentWebhookProcessingStore,
} from '../services/webhookProcessingService'

describe('historical failed subscription payment correlation', () => {
  const checkoutIntentId = new mongoose.Types.ObjectId()
  const userId = new mongoose.Types.ObjectId()
  const failedPaymentId = 'pay_FailedPay00001'
  const capturedPaymentId = 'pay_CapturedPay001'
  const orderId = 'order_SubOrder000001'
  const invoiceId = 'inv_SubInvoice0001'
  const subscriptionId = 'sub_Subscript00001'
  const planId = 'plan_MonthlyPlus001'
  const receipt = 'subscription-checkout-receipt'
  const authorizationExpiresAt = new Date('2026-08-01T00:00:00.000Z')

  const payment: RazorpayPaymentDto = {
    providerMode: 'test',
    id: failedPaymentId,
    orderId,
    invoiceId,
    amountPaise: 19_900,
    amountRefundedPaise: 0,
    currency: 'INR',
    status: 'failed',
    captured: false,
    method: 'upi',
    notes: {},
    error: { reason: 'payment_failed' },
    createdAtEpochSeconds: 1_754_006_400,
  }
  const invoice: RazorpayInvoiceDto = {
    providerMode: 'test',
    id: invoiceId,
    subscriptionId,
    paymentId: capturedPaymentId,
    orderId,
    status: 'paid',
    amountPaise: 19_900,
    amountPaidPaise: 19_900,
    amountDuePaise: 0,
    currency: 'INR',
    partialPayment: false,
    createdAtEpochSeconds: 1_754_006_400,
  }
  const subscription: RazorpaySubscriptionDto = {
    providerMode: 'test',
    id: subscriptionId,
    planId,
    status: 'active',
    totalCount: 12,
    paidCount: 1,
    remainingCount: 11,
    authorizationExpiresAtEpochSeconds: Math.floor(
      authorizationExpiresAt.getTime() / 1_000,
    ),
    notes: {
      checkout_receipt: receipt,
      checkout_intent_id: checkoutIntentId.toHexString(),
      catalog_version: 'catalog-v1',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: 1_754_006_400,
  }
  const checkout: TrustedSubscriptionWebhookCheckout = {
    _id: checkoutIntentId,
    userId,
    providerMode: 'test',
    status: 'remote_created',
    purpose: 'acquisition',
    leaseLane: 'a',
    authorizationExpiresAt,
    planKey: 'plus',
    catalogVersion: 'catalog-v1',
    razorpaySubscriptionId: subscriptionId,
    receipt,
  }

  it('uses invoice subscription lineage when a failed payment omits subscriptionId', async () => {
    const handlePaymentState = vi.fn().mockResolvedValue({
      outcome: 'handled',
      operationKey: `payment-state:test:${failedPaymentId}`,
    })
    const adapter = {
      providerMode: 'test',
      fetchPayment: vi.fn().mockResolvedValue(payment),
      fetchInvoice: vi.fn().mockResolvedValue(invoice),
      fetchSubscription: vi.fn().mockResolvedValue(subscription),
    } as unknown as RazorpayServerAdapter

    await expect(dispatchVerifiedRazorpayWebhook({
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'payment.failed',
      payload: {
        payment: {
          entity: {
            entity: 'payment',
            id: failedPaymentId,
            order_id: orderId,
            invoice_id: invoiceId,
          },
        },
      },
    }, {
      clientFactory: { forMode: () => adapter },
      store: {
        loadOneTimeIntentByOrder: vi.fn().mockResolvedValue(null),
        loadSubscriptionContext: vi.fn().mockResolvedValue({ checkout }),
      },
      effects: { handlePaymentState },
    })).resolves.toEqual(expect.objectContaining({
      outcome: 'effect_handled',
      effect: 'payment_state',
    }))

    expect(handlePaymentState).toHaveBeenCalledWith(
      expect.objectContaining({
        razorpayPaymentId: failedPaymentId,
        target: expect.objectContaining({
          kind: 'subscription',
          subscription: expect.objectContaining({ id: subscriptionId }),
        }),
      }),
    )
  })

  it('persists a distinct historical failure after the invoice has a later captured payment', async () => {
    const effect: PaymentStateEffectInput = {
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'payment.failed',
      razorpayPaymentId: failedPaymentId,
      razorpayOrderId: orderId,
      razorpayInvoiceId: invoiceId,
      payment,
      target: {
        kind: 'subscription',
        context: { checkout },
        subscription,
        invoice,
      },
    }
    const createAttempt = vi.fn().mockResolvedValue(
      new mongoose.Types.ObjectId(),
    )
    const transitionAttempt = vi.fn().mockResolvedValue(true)
    const loadAttempt = vi.fn().mockResolvedValue(null)
    const store: PaymentStatePersistenceStore = {
      async runTransaction(work) {
        return work({
          loadIntent: vi.fn().mockResolvedValue({
            id: checkoutIntentId,
            userId,
            kind: 'subscription',
            providerMode: 'test',
            status: 'remote_created',
            planKey: 'plus',
            catalogVersion: 'catalog-v1',
            razorpaySubscriptionId: subscriptionId,
            receipt,
          }),
          loadSubscription: vi.fn().mockResolvedValue(null),
          loadAttempt,
          createAttempt,
          transitionAttempt,
        })
      },
    }

    await expect(persistPaymentState(effect, {
      store,
      now: () => new Date('2026-08-01T00:02:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      razorpayPaymentId: failedPaymentId,
      paymentStatus: 'failed',
      stateChanged: true,
      supersededByLaterState: false,
    }))
    expect(loadAttempt).toHaveBeenCalledWith({
      providerMode: 'test',
      razorpayPaymentId: failedPaymentId,
    })
    expect(createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      razorpayPaymentId: failedPaymentId,
      razorpaySubscriptionId: subscriptionId,
      razorpayInvoiceId: invoiceId,
      status: 'failed',
    }))
    expect(transitionAttempt).not.toHaveBeenCalled()
  })

  it('keeps a captured attempt authoritative for the same payment id', async () => {
    const effect: PaymentStateEffectInput = {
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'payment.failed',
      razorpayPaymentId: failedPaymentId,
      razorpayOrderId: orderId,
      razorpayInvoiceId: invoiceId,
      payment,
      target: {
        kind: 'subscription',
        context: { checkout },
        subscription,
        invoice,
      },
    }
    const capturedAttempt: StoredPaymentStateAttempt = {
      id: new mongoose.Types.ObjectId(),
      providerMode: 'test',
      checkoutIntentId,
      razorpayPaymentId: failedPaymentId,
      razorpayOrderId: orderId,
      razorpaySubscriptionId: subscriptionId,
      razorpayInvoiceId: invoiceId,
      userId,
      status: 'captured',
      amountPaise: 19_900,
      currency: 'INR',
      providerSnapshot: { status: 'captured' },
      lastSyncedAt: new Date('2026-08-01T00:01:00.000Z'),
    }
    const createAttempt = vi.fn<
      (draft: PaymentStateAttemptDraft) => Promise<mongoose.Types.ObjectId>
    >()
    const transitionAttempt = vi.fn().mockResolvedValue(true)
    const store: PaymentStatePersistenceStore = {
      async runTransaction(work) {
        return work({
          loadIntent: vi.fn().mockResolvedValue({
            id: checkoutIntentId,
            userId,
            kind: 'subscription',
            providerMode: 'test',
            status: 'remote_created',
            planKey: 'plus',
            catalogVersion: 'catalog-v1',
            razorpaySubscriptionId: subscriptionId,
            receipt,
          }),
          loadSubscription: vi.fn().mockResolvedValue(null),
          loadAttempt: vi.fn().mockResolvedValue(capturedAttempt),
          createAttempt,
          transitionAttempt,
        })
      },
    }

    await expect(persistPaymentState(effect, {
      store,
      now: () => new Date('2026-08-01T00:02:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      paymentStatus: 'captured',
      stateChanged: false,
      supersededByLaterState: true,
    }))
    expect(createAttempt).not.toHaveBeenCalled()
    expect(transitionAttempt).not.toHaveBeenCalled()
  })

  it('rejects an invoice payment mismatch for a captured payment', async () => {
    const adapter = {
      providerMode: 'test',
      fetchPayment: vi.fn().mockResolvedValue({
        ...payment,
        status: 'captured',
        captured: true,
      }),
      fetchInvoice: vi.fn().mockResolvedValue(invoice),
    } as unknown as RazorpayServerAdapter

    await expect(dispatchVerifiedRazorpayWebhook({
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'payment.failed',
      payload: {
        payment: {
          entity: {
            entity: 'payment',
            id: failedPaymentId,
            order_id: orderId,
            invoice_id: invoiceId,
          },
        },
      },
    }, {
      clientFactory: { forMode: () => adapter },
    })).rejects.toMatchObject({
      name: 'WebhookDomainDispatchError',
      code: 'provider_reference_mismatch',
      disposition: 'review',
    })
  })
})

describe('webhook processing domain taxonomy', () => {
  it.each([
    {
      code: 'provider_reference_mismatch',
      disposition: 'review' as const,
      expectedStatus: 'dead_letter' as const,
      expectedOutcome: 'dead_letter' as const,
    },
    {
      code: 'provider_unavailable',
      disposition: 'retry' as const,
      expectedStatus: 'failed' as const,
      expectedOutcome: 'failed' as const,
    },
  ])('preserves $code and honors $disposition', async (testCase) => {
    const inboxEventId = new mongoose.Types.ObjectId().toHexString()
    const rawBody = Buffer.from(JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { entity: 'payment', id: 'pay_FailedPay00001' },
        },
      },
    }))
    const payloadHash = createHash('sha256').update(rawBody).digest('hex')
    const encryptionKey: WebhookPayloadEncryptionKey = {
      version: 'test-key-v1',
      key: Buffer.alloc(32, 7),
    }
    const encrypted = encryptWebhookPayload({
      rawBody,
      context: {
        providerMode: 'test',
        payloadHash,
        eventType: 'payment.failed',
      },
      encryptionKey,
      iv: Buffer.alloc(12, 3),
    })
    const claimed: ClaimedPaymentWebhookEvent = {
      id: inboxEventId,
      providerMode: 'test',
      eventType: 'payment.failed',
      payloadHash,
      rawPayloadStorage: { strategy: 'encrypted', ...encrypted },
      signatureVerified: true,
      attempts: 1,
    }
    const markFailed = vi.fn().mockResolvedValue(true)
    const store: PaymentWebhookProcessingStore = {
      claim: vi.fn().mockResolvedValue(claimed),
      readStatus: vi.fn(),
      markProcessed: vi.fn(),
      markFailed,
    }
    const handler = vi.fn().mockRejectedValue(
      new WebhookDomainDispatchError(
        testCase.code as 'provider_unavailable',
        testCase.disposition,
        'sensitive provider detail',
      ),
    )

    const result = await processPaymentWebhookEvent({
      eventId: inboxEventId,
      handler,
      keys: [encryptionKey],
      store,
      now: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(result).toEqual(expect.objectContaining({
      outcome: testCase.expectedOutcome,
      attempts: 1,
    }))
    expect(markFailed).toHaveBeenCalledWith({
      eventId: inboxEventId,
      claimAttempt: 1,
      status: testCase.expectedStatus,
      errorCode: testCase.code,
    })
  })
})
