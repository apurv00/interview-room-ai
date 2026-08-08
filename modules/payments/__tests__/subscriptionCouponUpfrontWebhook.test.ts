import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type { RazorpayClientFactory } from '../providers/razorpayClientFactory'
import type {
  RazorpayInvoiceDto,
  RazorpayPaymentDto,
  RazorpayServerAdapter,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import {
  dispatchVerifiedRazorpayWebhook,
  type WebhookDomainMappingStore,
} from '../services/webhookDomainDispatchService'

const paymentId = 'pay_A1234567890123'
const invoiceId = 'inv_A1234567890123'
const orderId = 'order_A1234567890123'
const providerSubscriptionId = 'sub_A1234567890123'
const startAtEpochSeconds = 1_702_678_400
const authorizationExpiresAtEpochSeconds = 1_700_086_400

function harness() {
  const intentId = new mongoose.Types.ObjectId()
  const userId = new mongoose.Types.ObjectId()
  const localSubscriptionId = new mongoose.Types.ObjectId()
  const receipt = 'subscription-coupon-upfront'
  const payment: RazorpayPaymentDto = {
    providerMode: 'test',
    id: paymentId,
    orderId,
    invoiceId,
    amountPaise: 49_900,
    amountRefundedPaise: 0,
    currency: 'INR',
    status: 'captured',
    captured: true,
    method: 'upi',
    notes: {},
    createdAtEpochSeconds: 1_700_000_000,
  }
  const invoice: RazorpayInvoiceDto = {
    providerMode: 'test',
    id: invoiceId,
    subscriptionId: providerSubscriptionId,
    paymentId,
    orderId,
    status: 'paid',
    amountPaise: 49_900,
    amountPaidPaise: 49_900,
    amountDuePaise: 0,
    currency: 'INR',
    partialPayment: false,
    paidAtEpochSeconds: 1_700_000_000,
    createdAtEpochSeconds: 1_700_000_000,
  }
  const subscription: RazorpaySubscriptionDto = {
    providerMode: 'test',
    id: providerSubscriptionId,
    planId: 'plan_PlusMonthly123',
    status: 'authenticated',
    totalCount: 120,
    paidCount: 0,
    remainingCount: 120,
    startAtEpochSeconds,
    authorizationExpiresAtEpochSeconds,
    notes: {
      checkout_receipt: receipt,
      checkout_intent_id: intentId.toHexString(),
      catalog_version: 'catalog-v1',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: 1_700_000_000,
  }
  const adapter = {
    providerMode: 'test',
    fetchPayment: vi.fn().mockResolvedValue(payment),
    fetchInvoice: vi.fn().mockResolvedValue(invoice),
    fetchSubscription: vi.fn().mockResolvedValue(subscription),
  } as unknown as RazorpayServerAdapter
  const clientFactory: RazorpayClientFactory = {
    forMode: () => adapter,
  }
  const store: WebhookDomainMappingStore = {
    loadOneTimeIntentByOrder: vi.fn().mockResolvedValue(null),
    loadSubscriptionContext: vi.fn().mockResolvedValue({
      checkout: {
        _id: intentId,
        userId,
        providerMode: 'test',
        status: 'checkout_opened',
        purpose: 'acquisition',
        leaseLane: 'a',
        requestedStartAt: new Date(startAtEpochSeconds * 1_000),
        authorizationExpiresAt:
          new Date(authorizationExpiresAtEpochSeconds * 1_000),
        planKey: 'plus',
        catalogVersion: 'catalog-v1',
        razorpaySubscriptionId: providerSubscriptionId,
        receipt,
      },
      subscription: {
        _id: localSubscriptionId,
        userId,
        providerMode: 'test',
        planKey: 'plus',
        catalogVersion: 'catalog-v1',
        razorpayPlanId: 'plan_PlusMonthly123',
        razorpaySubscriptionId: providerSubscriptionId,
        checkoutIntentId: intentId,
        leaseLane: 'a',
        requestedStartAt: new Date(startAtEpochSeconds * 1_000),
        authorizationExpiresAt:
          new Date(authorizationExpiresAtEpochSeconds * 1_000),
        status: 'authenticated',
        source: 'customer',
      },
    }),
  }
  const handleSubscriptionUpfront = vi.fn().mockResolvedValue({
    outcome: 'handled',
    operationKey: `test:${paymentId}:entitlement`,
  })
  const envelope = {
    inboxEventId: new mongoose.Types.ObjectId().toHexString(),
    providerMode: 'test' as const,
    eventType: 'payment.captured' as const,
    payload: {
      payment: {
        entity: {
          entity: 'payment',
          id: paymentId,
          order_id: orderId,
          invoice_id: invoiceId,
        },
      },
    },
  }
  return {
    adapter,
    clientFactory,
    store,
    handleSubscriptionUpfront,
    envelope,
  }
}

describe('coupon upfront webhook dispatch', () => {
  it('uses the captured server-fetched upfront invoice as entitlement authority', async () => {
    const test = harness()

    const result = await dispatchVerifiedRazorpayWebhook(test.envelope, {
      clientFactory: test.clientFactory,
      store: test.store,
      effects: {
        handleSubscriptionUpfront: test.handleSubscriptionUpfront,
      },
    })

    expect(result).toMatchObject({
      outcome: 'effect_handled',
      effect: 'subscription_upfront',
      eventType: 'payment.captured',
      operationKey: `test:${paymentId}:entitlement`,
    })
    expect(test.adapter.fetchInvoice).toHaveBeenCalledWith(invoiceId)
    expect(test.handleSubscriptionUpfront).toHaveBeenCalledWith(
      expect.objectContaining({
        razorpayPaymentId: paymentId,
        razorpayInvoiceId: invoiceId,
        razorpayOrderId: orderId,
        razorpaySubscriptionId: providerSubscriptionId,
      }),
    )
  })

  it('fails closed before entitlement when the invoice amount differs', async () => {
    const test = harness()
    test.adapter.fetchInvoice = vi.fn().mockResolvedValue({
      ...(await test.adapter.fetchInvoice(invoiceId)),
      amountPaise: 59_900,
      amountPaidPaise: 59_900,
    })

    await expect(
      dispatchVerifiedRazorpayWebhook(test.envelope, {
        clientFactory: test.clientFactory,
        store: test.store,
        effects: {
          handleSubscriptionUpfront: test.handleSubscriptionUpfront,
        },
      }),
    ).rejects.toMatchObject({
      code: 'provider_state_not_ready',
      disposition: 'review',
    })
    expect(test.handleSubscriptionUpfront).not.toHaveBeenCalled()
  })
})
