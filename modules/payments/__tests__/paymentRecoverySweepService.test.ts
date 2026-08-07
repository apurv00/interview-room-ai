import { describe, expect, it, vi } from 'vitest'
import type { RazorpayClientFactory } from '../providers/razorpayClientFactory'
import type { RazorpayServerAdapter } from '../providers/razorpayServerAdapter'
import {
  PAYMENT_RECOVERY_PROVIDER_MODES_ENV,
  PaymentRecoveryConfigurationError,
  parsePaymentRecoveryProviderModes,
  runPaymentRecoverySweep,
  selectSubscriptionRecoveryCandidates,
  type PaymentRecoveryCandidateStore,
} from '../services/paymentRecoverySweepService'

const eventId = '507f1f77bcf86cd799439011'
const fulfillmentId = '507f1f77bcf86cd799439012'
const subscriptionId = 'sub_launchrecovery1'
const paymentId = 'pay_launchrecovery1'
const invoiceId = 'inv_launchrecovery1'
const orderId = 'order_launchrecovery1'
const couponReservationId = '507f1f77bcf86cd799439013'
const couponCampaignId = '507f1f77bcf86cd799439014'
const couponUserId = '507f1f77bcf86cd799439015'
const couponCheckoutId = '507f1f77bcf86cd799439016'
const couponReceipt = 'checkout_coupon_recovery_1'

function couponCandidate() {
  return {
    id: couponReservationId,
    providerMode: 'live' as const,
    campaignId: couponCampaignId,
    userId: couponUserId,
    checkoutIntentId: couponCheckoutId,
    validUntil: new Date('2026-08-07T05:00:00.000Z'),
  }
}

function couponCheckout(overrides: Record<string, unknown> = {}) {
  return {
    id: couponCheckoutId,
    providerMode: 'live' as const,
    userId: couponUserId,
    campaignId: couponCampaignId,
    status: 'created',
    receipt: couponReceipt,
    razorpayPlanId: 'plan_launchrecovery1',
    createdAt: new Date('2026-08-06T06:00:00.000Z'),
    ...overrides,
  }
}

function emptyStore(
  overrides: Partial<PaymentRecoveryCandidateStore> = {},
): PaymentRecoveryCandidateStore {
  return {
    listWebhookCandidates: vi.fn().mockResolvedValue([]),
    listCouponCandidates: vi.fn().mockResolvedValue([]),
    loadCouponCheckout: vi.fn().mockResolvedValue(null),
    cancelUnstartedCouponCheckout: vi.fn().mockResolvedValue(false),
    listSubscriptionCandidates: vi.fn().mockResolvedValue([]),
    markSubscriptionAttempted: vi.fn().mockResolvedValue(undefined),
    listChargeCandidates: vi.fn().mockResolvedValue([]),
    listCreditNoteCandidates: vi.fn().mockResolvedValue([]),
    deferChargeCandidate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function liveClient(overrides: Partial<RazorpayServerAdapter> = {}) {
  const adapter = {
    providerMode: 'live',
    fetchSubscription: vi.fn().mockResolvedValue({
      providerMode: 'live',
      id: subscriptionId,
      planId: 'plan_launchrecovery1',
      status: 'active',
      totalCount: 12,
      paidCount: 1,
      remainingCount: 11,
      notes: {},
      createdAtEpochSeconds: 1_700_000_000,
    }),
    findSubscriptionByCheckoutReceipt: vi.fn().mockResolvedValue(null),
    fetchSubscriptionInvoices: vi.fn().mockResolvedValue([{
      providerMode: 'live',
      id: invoiceId,
      subscriptionId,
      paymentId,
      orderId,
      status: 'paid',
      amountPaise: 59_900,
      amountPaidPaise: 59_900,
      amountDuePaise: 0,
      currency: 'INR',
      partialPayment: false,
      billingStartEpochSeconds: 1_700_000_000,
      billingEndEpochSeconds: 1_702_592_000,
      createdAtEpochSeconds: 1_700_000_000,
    }]),
    fetchPayment: vi.fn().mockResolvedValue({
      providerMode: 'live',
      id: paymentId,
      subscriptionId,
      invoiceId,
      orderId,
      amountPaise: 59_900,
      amountRefundedPaise: 0,
      currency: 'INR',
      status: 'captured',
      captured: true,
      method: 'upi',
      notes: {},
      createdAtEpochSeconds: 1_700_000_000,
    }),
    ...overrides,
  } as unknown as RazorpayServerAdapter
  const factory: RazorpayClientFactory = {
    forMode: vi.fn(() => adapter),
  }
  return { adapter, factory }
}

describe('payment recovery provider-mode authorization', () => {
  it('is inert until a provider mode is explicitly listed', () => {
    expect(parsePaymentRecoveryProviderModes({})).toEqual([])
    expect(parsePaymentRecoveryProviderModes({
      [PAYMENT_RECOVERY_PROVIDER_MODES_ENV]: 'live',
    })).toEqual(['live'])
    expect(parsePaymentRecoveryProviderModes({
      [PAYMENT_RECOVERY_PROVIDER_MODES_ENV]: 'live,test',
    })).toEqual(['test', 'live'])
  })

  it.each(['production', 'all', 'live,live', 'test, live, extra'])(
    'fails closed for invalid provider authorization %s',
    (value) => {
      expect(() => parsePaymentRecoveryProviderModes({
        [PAYMENT_RECOVERY_PROVIDER_MODES_ENV]: value,
      })).toThrow(PaymentRecoveryConfigurationError)
    },
  )
})

describe('bounded payment recovery sweep', () => {
  it('reserves a due active subscription slot under a saturated checkout backlog', () => {
    const checkouts = Array.from({ length: 15 }, (_, index) => ({
      providerMode: 'live' as const,
      razorpaySubscriptionId: `sub_checkoutbacklog${index + 1}`,
    }))
    const activeSubscriptionId = 'sub_dueactive1'

    const selected = selectSubscriptionRecoveryCandidates({
      checkouts,
      subscriptions: [
        checkouts[0],
        {
          providerMode: 'live',
          razorpaySubscriptionId: activeSubscriptionId,
        },
      ],
      limit: 5,
    })

    expect(selected).toHaveLength(5)
    expect(selected.filter((candidate) => (
      candidate.acquisitionCheckoutPending
    ))).toHaveLength(4)
    expect(selected).toContainEqual({
      providerMode: 'live',
      razorpaySubscriptionId: activeSubscriptionId,
      acquisitionCheckoutPending: false,
    })
    expect(selected.find((candidate) => (
      candidate.razorpaySubscriptionId ===
        checkouts[0].razorpaySubscriptionId
    ))?.acquisitionCheckoutPending).toBe(true)
  })

  it('retries the existing webhook composition, reconciles one paid cycle, and recovers one entitlement', async () => {
    const store = emptyStore({
      listWebhookCandidates: vi.fn().mockResolvedValue([{
        eventId,
        providerMode: 'live',
      }]),
      listSubscriptionCandidates: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        acquisitionCheckoutPending: false,
        localPaymentIds: [],
      }]),
      listChargeCandidates: vi.fn().mockResolvedValue([{
        fulfillmentId,
        providerMode: 'live',
      }]),
    })
    const { adapter, factory } = liveClient()
    const webhookHandler = vi.fn()
    const processWebhook = vi.fn().mockResolvedValue({
      outcome: 'processed',
      eventType: 'subscription.charged',
      attempts: 2,
    })
    const localContext = { checkout: { id: 'exact' } }
    const loadSubscriptionContext = vi.fn().mockResolvedValue(localContext)
    const persistSubscription = vi.fn().mockResolvedValue({})
    const fulfillSubscriptionCycle = vi.fn().mockResolvedValue({})
    const recoverCharge = vi.fn().mockResolvedValue({
      outcome: 'one_time_entitlement_processed',
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now: new Date('2026-08-07T06:00:00.000Z'),
    }, {
      store,
      webhookHandler,
      processWebhook,
      clientFactory: factory,
      loadSubscriptionContext,
      persistSubscription: persistSubscription as never,
      fulfillSubscriptionCycle: fulfillSubscriptionCycle as never,
      recoverCharge: recoverCharge as never,
    })

    expect(result).toEqual({
      providerModes: ['live'],
      webhook: {
        candidates: 1,
        completed: 1,
        deferred: 0,
        failed: 0,
      },
      coupon: {
        candidates: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
      },
      subscription: {
        candidates: 1,
        completed: 1,
        deferred: 0,
        failed: 0,
        cyclesRecovered: 1,
      },
      charge: {
        candidates: 1,
        completed: 1,
        deferred: 0,
        failed: 0,
      },
      creditNote: {
        candidates: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
      },
    })
    expect(processWebhook).toHaveBeenCalledWith({
      eventId,
      handler: webhookHandler,
      now: new Date('2026-08-07T06:00:00.000Z'),
    })
    expect(factory.forMode).toHaveBeenCalledWith('live')
    expect(adapter.fetchSubscriptionInvoices).toHaveBeenCalledWith(
      subscriptionId,
    )
    expect(fulfillSubscriptionCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        razorpayPaymentId: paymentId,
        razorpayInvoiceId: invoiceId,
        razorpayOrderId: orderId,
      }),
    )
    expect(persistSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'live',
        providerObservedAt: new Date('2026-08-07T06:00:00.000Z'),
        razorpaySubscriptionId: subscriptionId,
        localContext,
      }),
    )
    expect(recoverCharge).toHaveBeenCalledWith({
      fulfillmentId,
      providerMode: 'live',
    })
  })

  it('expires an overdue coupon only after remote absence and a checkout CAS', async () => {
    const now = new Date('2026-08-07T06:00:00.000Z')
    const store = emptyStore({
      listCouponCandidates: vi.fn().mockResolvedValue([
        couponCandidate(),
      ]),
      loadCouponCheckout: vi.fn().mockResolvedValue(couponCheckout()),
      cancelUnstartedCouponCheckout:
        vi.fn().mockResolvedValue(true),
    })
    const { adapter, factory } = liveClient()
    const expireCoupon = vi.fn().mockResolvedValue({ outcome: 'expired' })
    const releaseCoupon = vi.fn()
    const reviewCoupon = vi.fn()

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now,
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      expireCoupon: expireCoupon as never,
      releaseCoupon: releaseCoupon as never,
      reviewCoupon: reviewCoupon as never,
    })

    expect(result.coupon).toEqual({
      candidates: 1,
      completed: 1,
      deferred: 0,
      failed: 0,
    })
    expect(adapter.findSubscriptionByCheckoutReceipt)
      .toHaveBeenCalledWith(expect.objectContaining({
        checkoutReceipt: couponReceipt,
        expectedPlanId: 'plan_launchrecovery1',
      }))
    expect(store.cancelUnstartedCouponCheckout).toHaveBeenCalledWith({
      checkout: couponCheckout(),
      now,
    })
    expect(expireCoupon).toHaveBeenCalledWith(expect.objectContaining({
      checkoutIntentId: couponCheckoutId,
      evidence: expect.objectContaining({
        reason: 'local_intent_expired_without_remote_object',
        source: 'reconciliation',
      }),
    }))
    expect(releaseCoupon).not.toHaveBeenCalled()
    expect(reviewCoupon).not.toHaveBeenCalled()
  })

  it('releases coupon capacity for an exactly matched terminal unpaid subscription', async () => {
    const now = new Date('2026-08-07T06:00:00.000Z')
    const store = emptyStore({
      listCouponCandidates: vi.fn().mockResolvedValue([
        couponCandidate(),
      ]),
      loadCouponCheckout: vi.fn().mockResolvedValue(couponCheckout({
        status: 'remote_created',
        razorpaySubscriptionId: subscriptionId,
      })),
    })
    const { factory } = liveClient({
      fetchSubscription: vi.fn().mockResolvedValue({
        providerMode: 'live',
        id: subscriptionId,
        planId: 'plan_launchrecovery1',
        status: 'cancelled',
        totalCount: 12,
        paidCount: 0,
        remainingCount: 12,
        notes: { checkout_receipt: couponReceipt },
        createdAtEpochSeconds: 1_700_000_000,
      }),
      fetchSubscriptionInvoices: vi.fn().mockResolvedValue([]),
    })
    const releaseCoupon = vi.fn().mockResolvedValue({
      outcome: 'released',
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now,
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      expireCoupon: vi.fn() as never,
      releaseCoupon: releaseCoupon as never,
      reviewCoupon: vi.fn() as never,
    })

    expect(result.coupon.completed).toBe(1)
    expect(releaseCoupon).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        reason: 'provider_subscription_cancelled_unpaid',
        source: 'provider_fetch',
      }),
    }))
  })

  it('does not free coupon capacity when terminal provider state has payment evidence', async () => {
    const store = emptyStore({
      listCouponCandidates: vi.fn().mockResolvedValue([
        couponCandidate(),
      ]),
      loadCouponCheckout: vi.fn().mockResolvedValue(couponCheckout({
        status: 'remote_created',
        razorpaySubscriptionId: subscriptionId,
      })),
    })
    const { factory } = liveClient({
      fetchSubscription: vi.fn().mockResolvedValue({
        providerMode: 'live',
        id: subscriptionId,
        planId: 'plan_launchrecovery1',
        status: 'cancelled',
        totalCount: 12,
        paidCount: 1,
        remainingCount: 11,
        notes: { checkout_receipt: couponReceipt },
        createdAtEpochSeconds: 1_700_000_000,
      }),
      fetchSubscriptionInvoices: vi.fn().mockResolvedValue([]),
    })
    const releaseCoupon = vi.fn()
    const reviewCoupon = vi.fn().mockResolvedValue({})

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now: new Date('2026-08-07T06:00:00.000Z'),
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      expireCoupon: vi.fn() as never,
      releaseCoupon: releaseCoupon as never,
      reviewCoupon: reviewCoupon as never,
    })

    expect(result.coupon.completed).toBe(1)
    expect(releaseCoupon).not.toHaveBeenCalled()
    expect(reviewCoupon).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ambiguous_remote_state',
    }))
  })

  it('defers an overdue coupon while a remote-creation lease is active', async () => {
    const now = new Date('2026-08-07T06:00:00.000Z')
    const store = emptyStore({
      listCouponCandidates: vi.fn().mockResolvedValue([
        couponCandidate(),
      ]),
      loadCouponCheckout: vi.fn().mockResolvedValue(couponCheckout({
        remoteCreationLeaseExpiresAt:
          new Date('2026-08-07T06:01:00.000Z'),
      })),
    })
    const { factory } = liveClient()
    const expireCoupon = vi.fn()

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now,
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      expireCoupon: expireCoupon as never,
      releaseCoupon: vi.fn() as never,
      reviewCoupon: vi.fn() as never,
    })

    expect(result.coupon).toEqual({
      candidates: 1,
      completed: 0,
      deferred: 1,
      failed: 0,
    })
    expect(store.cancelUnstartedCouponCheckout).not.toHaveBeenCalled()
    expect(expireCoupon).not.toHaveBeenCalled()
  })

  it('does not enumerate invoices when provider reports no paid renewal and checkout is complete', async () => {
    const store = emptyStore({
      listSubscriptionCandidates: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        acquisitionCheckoutPending: false,
        localPaymentIds: [paymentId],
      }]),
    })
    const { adapter, factory } = liveClient({
      fetchSubscription: vi.fn().mockResolvedValue({
        providerMode: 'live',
        id: subscriptionId,
        planId: 'plan_launchrecovery1',
        status: 'authenticated',
        totalCount: 12,
        paidCount: 0,
        remainingCount: 12,
        notes: {},
        createdAtEpochSeconds: 1_700_000_000,
      }),
    })
    const persistSubscription = vi.fn().mockResolvedValue({})

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      loadSubscriptionContext: vi.fn().mockResolvedValue({}),
      persistSubscription: persistSubscription as never,
    })

    expect(result.subscription.completed).toBe(1)
    expect(result.subscription.cyclesRecovered).toBe(0)
    expect(adapter.fetchSubscriptionInvoices).not.toHaveBeenCalled()
    expect(persistSubscription).toHaveBeenCalledOnce()
  })

  it('does not let coupon-upfront evidence mask a missing first renewal', async () => {
    const upfrontPaymentId = 'pay_couponupfront1'
    const renewalPaymentId = 'pay_firstrenewal1'
    const renewalInvoiceId = 'inv_firstrenewal1'
    const renewalOrderId = 'order_firstrenewal1'
    const store = emptyStore({
      listSubscriptionCandidates: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        acquisitionCheckoutPending: false,
        localPaymentIds: [upfrontPaymentId],
      }]),
    })
    const { adapter, factory } = liveClient({
      fetchSubscriptionInvoices: vi.fn().mockResolvedValue([
        {
          providerMode: 'live',
          id: 'inv_couponupfront1',
          subscriptionId,
          paymentId: upfrontPaymentId,
          orderId: 'order_couponupfront1',
          status: 'paid',
          amountPaise: 49_900,
          amountPaidPaise: 49_900,
          amountDuePaise: 0,
          currency: 'INR',
          partialPayment: false,
          createdAtEpochSeconds: 1_700_000_000,
        },
        {
          providerMode: 'live',
          id: renewalInvoiceId,
          subscriptionId,
          paymentId: renewalPaymentId,
          orderId: renewalOrderId,
          status: 'paid',
          amountPaise: 59_900,
          amountPaidPaise: 59_900,
          amountDuePaise: 0,
          currency: 'INR',
          partialPayment: false,
          billingStartEpochSeconds: 1_702_592_000,
          billingEndEpochSeconds: 1_705_184_000,
          createdAtEpochSeconds: 1_702_592_000,
        },
      ]),
      fetchPayment: vi.fn().mockResolvedValue({
        providerMode: 'live',
        id: renewalPaymentId,
        subscriptionId,
        invoiceId: renewalInvoiceId,
        orderId: renewalOrderId,
        amountPaise: 59_900,
        amountRefundedPaise: 0,
        currency: 'INR',
        status: 'captured',
        captured: true,
        method: 'upi',
        notes: {},
        createdAtEpochSeconds: 1_702_592_000,
      }),
    })
    const fulfillSubscriptionCycle = vi.fn().mockResolvedValue({})

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      loadSubscriptionContext: vi.fn().mockResolvedValue({}),
      persistSubscription: vi.fn().mockResolvedValue({}) as never,
      fulfillSubscriptionCycle: fulfillSubscriptionCycle as never,
    })

    expect(adapter.fetchSubscriptionInvoices).toHaveBeenCalledOnce()
    expect(fulfillSubscriptionCycle).toHaveBeenCalledOnce()
    expect(fulfillSubscriptionCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        razorpayPaymentId: renewalPaymentId,
        razorpayInvoiceId: renewalInvoiceId,
      }),
    )
    expect(result.subscription.cyclesRecovered).toBe(1)
  })

  it('defers coupon upfront invoices to the existing signed-webhook recovery path', async () => {
    const store = emptyStore({
      listSubscriptionCandidates: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        acquisitionCheckoutPending: true,
        localPaymentIds: [],
      }]),
    })
    const { adapter, factory } = liveClient({
      fetchSubscription: vi.fn().mockResolvedValue({
        providerMode: 'live',
        id: subscriptionId,
        planId: 'plan_launchrecovery1',
        status: 'authenticated',
        totalCount: 12,
        paidCount: 0,
        remainingCount: 12,
        notes: {},
        createdAtEpochSeconds: 1_700_000_000,
      }),
      fetchSubscriptionInvoices: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        id: invoiceId,
        subscriptionId,
        paymentId,
        orderId,
        status: 'paid',
        amountPaise: 49_900,
        amountPaidPaise: 49_900,
        amountDuePaise: 0,
        currency: 'INR',
        partialPayment: false,
        createdAtEpochSeconds: 1_700_000_000,
      }]),
    })
    const fulfillSubscriptionCycle = vi.fn()

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      loadSubscriptionContext: vi.fn().mockResolvedValue({}),
      persistSubscription: vi.fn().mockResolvedValue({}) as never,
      fulfillSubscriptionCycle: fulfillSubscriptionCycle as never,
    })

    expect(adapter.fetchSubscriptionInvoices).toHaveBeenCalledOnce()
    expect(fulfillSubscriptionCycle).not.toHaveBeenCalled()
    expect(result.subscription.cyclesRecovered).toBe(0)
    expect(result.subscription.deferred).toBe(1)
  })

  it('backs off a charge while the approved invoice policy is unavailable', async () => {
    const store = emptyStore({
      listChargeCandidates: vi.fn().mockResolvedValue([{
        fulfillmentId,
        providerMode: 'test',
      }]),
    })
    const recoverCharge = vi.fn().mockResolvedValue({
      outcome: 'financial_policy_required',
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['test'],
    }, {
      store,
      webhookHandler: vi.fn(),
      recoverCharge: recoverCharge as never,
    })

    expect(result.charge).toEqual({
      candidates: 1,
      completed: 0,
      deferred: 1,
      failed: 0,
    })
    expect(recoverCharge).toHaveBeenCalledOnce()
    expect(store.deferChargeCandidate).toHaveBeenCalledWith({
      fulfillmentId,
      providerMode: 'test',
      attemptedAt: expect.any(Date),
      nextAttemptAt: expect.any(Date),
    })
  })

  it('counts an approved invoice recovery as completed without deferring it', async () => {
    const store = emptyStore({
      listChargeCandidates: vi.fn().mockResolvedValue([{
        fulfillmentId,
        providerMode: 'live',
      }]),
    })
    const recoverCharge = vi.fn().mockResolvedValue({
      outcome: 'financial_policy_handler_completed',
      financialPolicy: {
        disposition: 'invoiced',
        invoiceReferenceId: '507f1f77bcf86cd799439011',
      },
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
    }, {
      store,
      webhookHandler: vi.fn(),
      recoverCharge: recoverCharge as never,
    })

    expect(result.charge).toEqual({
      candidates: 1,
      completed: 1,
      deferred: 0,
      failed: 0,
    })
    expect(store.deferChargeCandidate).not.toHaveBeenCalled()
  })

  it('runs bounded processed-refund credit-note recovery after charge recovery', async () => {
    const refundRecordId = '507f1f77bcf86cd799439017'
    const store = emptyStore({
      listCreditNoteCandidates: vi.fn().mockResolvedValue([{
        refundRecordId,
        providerMode: 'live',
      }]),
    })
    const recoverCreditNote = vi.fn().mockResolvedValue({
      disposition: 'issued',
      creditNoteReferenceId: '507f1f77bcf86cd799439018',
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
    }, {
      store,
      webhookHandler: vi.fn(),
      recoverCreditNote: recoverCreditNote as never,
    })

    expect(result.creditNote).toEqual({
      candidates: 1,
      completed: 1,
      deferred: 0,
      failed: 0,
    })
    expect(recoverCreditNote).toHaveBeenCalledWith({
      refundRecordId,
      providerMode: 'live',
    })
  })

  it('durably rotates active subscription candidates instead of polling the oldest five every five minutes', async () => {
    const candidateIds = Array.from(
      { length: 6 },
      (_, index) => `sub_rotation${index + 1}`,
    )
    const attemptedAtById = new Map<string, Date>()
    const listSubscriptionCandidates = vi.fn(async ({
      now,
      limit,
    }: {
      now: Date
      limit: number
    }) => candidateIds
      .filter((candidateId) => {
        const lastAttemptedAt = attemptedAtById.get(candidateId)
        return !lastAttemptedAt ||
          lastAttemptedAt.getTime() <=
            now.getTime() - 6 * 60 * 60 * 1000
      })
      .slice(0, limit)
      .map((candidateId) => ({
        providerMode: 'live' as const,
        razorpaySubscriptionId: candidateId,
        acquisitionCheckoutPending: false,
        localPaymentIds: [],
      })))
    const markSubscriptionAttempted = vi.fn(async ({
      razorpaySubscriptionId,
      attemptedAt,
    }: {
      razorpaySubscriptionId: string
      attemptedAt: Date
    }) => {
      attemptedAtById.set(razorpaySubscriptionId, attemptedAt)
    })
    const store = emptyStore({
      listSubscriptionCandidates,
      markSubscriptionAttempted,
    })
    const { factory } = liveClient({
      fetchSubscription: vi.fn(async (candidateId: string) => ({
        providerMode: 'live' as const,
        id: candidateId,
        planId: 'plan_launchrecovery1',
        status: 'active' as const,
        totalCount: 12,
        paidCount: 0,
        remainingCount: 12,
        notes: {},
        createdAtEpochSeconds: 1_700_000_000,
      })),
    })
    const dependencies = {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      loadSubscriptionContext: vi.fn().mockResolvedValue({}),
      persistSubscription: vi.fn().mockResolvedValue({}) as never,
    }
    const firstRunAt = new Date('2026-08-07T06:00:00.000Z')

    const first = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now: firstRunAt,
    }, dependencies)
    const second = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now: new Date(firstRunAt.getTime() + 5 * 60 * 1000),
    }, dependencies)

    expect(first.subscription.candidates).toBe(5)
    expect(second.subscription.candidates).toBe(1)
    expect(markSubscriptionAttempted.mock.calls
      .map(([attempt]) => attempt.razorpaySubscriptionId))
      .toEqual(candidateIds)
  })

  it('backs off an incomplete checkout even when provider observation fails', async () => {
    const now = new Date('2026-08-07T06:00:00.000Z')
    const store = emptyStore({
      listSubscriptionCandidates: vi.fn().mockResolvedValue([{
        providerMode: 'live',
        razorpaySubscriptionId: subscriptionId,
        acquisitionCheckoutPending: true,
        localPaymentIds: [],
      }]),
    })
    const { factory } = liveClient({
      fetchSubscription: vi.fn().mockRejectedValue(
        new Error('provider unavailable'),
      ),
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now,
    }, {
      store,
      webhookHandler: vi.fn(),
      clientFactory: factory,
      loadSubscriptionContext: vi.fn().mockResolvedValue({}),
    })

    expect(result.subscription.failed).toBe(1)
    expect(store.markSubscriptionAttempted).toHaveBeenCalledWith({
      providerMode: 'live',
      razorpaySubscriptionId: subscriptionId,
      attemptedAt: now,
      checkoutNextRecoveryAt: new Date(
        now.getTime() + 15 * 60 * 1000,
      ),
    })
  })

  it('backs off a failed one-time entitlement candidate', async () => {
    const now = new Date('2026-08-07T06:00:00.000Z')
    const store = emptyStore({
      listChargeCandidates: vi.fn().mockResolvedValue([{
        fulfillmentId,
        providerMode: 'live',
      }]),
    })

    const result = await runPaymentRecoverySweep({
      providerModes: ['live'],
      now,
    }, {
      store,
      webhookHandler: vi.fn(),
      recoverCharge: vi.fn().mockRejectedValue(
        new Error('entitlement unavailable'),
      ) as never,
    })

    expect(result.charge.failed).toBe(1)
    expect(store.deferChargeCandidate).toHaveBeenCalledWith({
      fulfillmentId,
      providerMode: 'live',
      attemptedAt: now,
      nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000),
    })
  })

  it('rejects a candidate store that crosses the authorized provider mode', async () => {
    const store = emptyStore({
      listWebhookCandidates: vi.fn().mockResolvedValue([{
        eventId,
        providerMode: 'live',
      }]),
    })

    await expect(runPaymentRecoverySweep({
      providerModes: ['test'],
    }, {
      store,
      webhookHandler: vi.fn(),
    })).rejects.toThrow(PaymentRecoveryConfigurationError)
  })
})
