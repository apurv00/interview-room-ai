import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  RazorpayInvoiceDto,
  RazorpayPaymentDto,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import {
  fulfillSubscriptionCycleProviderObservation,
  type OriginalSubscriptionCheckoutIntent,
  type ResolvedSubscriptionCommercialTerms,
} from '../services/subscriptionCycleFulfillmentService'

const paymentId = 'pay_UpfrontRecovery123'
const invoiceId = 'inv_UpfrontRecovery123'
const orderId = 'order_UpfrontRecovery123'
const subscriptionId = 'sub_UpfrontRecovery123'
const planId = 'plan_PlusMonthly123'
const periodStartEpochSeconds = 1_700_000_000
const authorizationExpiresAtEpochSeconds = 1_700_086_400
const periodEndEpochSeconds = 1_702_678_400

function upfrontHarness(invoiceOverrides: Partial<RazorpayInvoiceDto> = {}) {
  const intentId = new mongoose.Types.ObjectId()
  const userId = new mongoose.Types.ObjectId()
  const campaignId = new mongoose.Types.ObjectId()
  const receipt = 'subscription-upfront-recovery'
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
    createdAtEpochSeconds: periodStartEpochSeconds,
  }
  const invoice: RazorpayInvoiceDto = {
    providerMode: 'test',
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
    paidAtEpochSeconds: periodStartEpochSeconds,
    createdAtEpochSeconds: periodStartEpochSeconds,
    ...invoiceOverrides,
  }
  const subscription: RazorpaySubscriptionDto = {
    providerMode: 'test',
    id: subscriptionId,
    planId,
    status: 'authenticated',
    totalCount: 120,
    paidCount: 0,
    remainingCount: 120,
    startAtEpochSeconds: periodEndEpochSeconds,
    authorizationExpiresAtEpochSeconds,
    notes: {
      checkout_receipt: receipt,
      checkout_intent_id: intentId.toHexString(),
      catalog_version: 'catalog-v1',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: periodStartEpochSeconds,
  }
  const intent: OriginalSubscriptionCheckoutIntent = {
    id: intentId,
    userId,
    kind: 'subscription',
    providerMode: 'test',
    status: 'checkout_opened',
    purpose: 'acquisition',
    leaseLane: 'a',
    requestedStartAt: new Date(periodEndEpochSeconds * 1_000),
    authorizationExpiresAt:
      new Date(authorizationExpiresAtEpochSeconds * 1_000),
    planKey: 'plus',
    catalogVersion: 'catalog-v1',
    razorpaySubscriptionId: subscriptionId,
    receipt,
    createdAt: new Date((periodStartEpochSeconds - 60) * 1_000),
    quote: {
      currency: 'INR',
      listPricePaise: 59_900,
      discountPaise: 10_000,
      payablePaise: 49_900,
      renewalPricePaise: 59_900,
      discountedBillingCycles: 1,
      couponCampaignId: campaignId,
      couponCampaignRevision: 1,
    },
  }
  const terms: ResolvedSubscriptionCommercialTerms = {
    catalog: {
      version: 'catalog-v1',
      contentHash: 'catalog-content',
      status: 'published',
      integrityVerified: true,
      plan: {
        key: 'plus',
        listPricePaise: 59_900,
        billingPeriod: 'monthly',
        interviewLimit: 10,
        interviewPeriodOwner: 'razorpay_billing_cycle',
        maxInterviewDurationMinutes: 30,
        basicSavedResumeLimit: 1,
        premiumResumeLimit: 5,
        razorpayPlanId: planId,
      },
    },
    coupon: {
      campaignId,
      revision: 1,
      status: 'active',
      contentHash: 'coupon-content',
      integrityVerified: true,
      discountPaise: 10_000,
      applicablePlanKeys: ['plus'],
      discountedBillingCycles: 1,
      termsText: 'Save INR 100 on the first billing cycle.',
    },
  }
  const persistCycle = vi.fn().mockImplementation(async ({ draft }) => ({
    checkoutIntentId: intentId.toHexString(),
    localSubscriptionId: new mongoose.Types.ObjectId().toHexString(),
    subscriptionCycleId: new mongoose.Types.ObjectId().toHexString(),
    fulfillmentId: new mongoose.Types.ObjectId().toHexString(),
    periodKey: draft.periodKey,
    reused: false,
    projectionApplied: true,
    projectionDisposition: 'projected',
    requiresFinancialReview: false,
  }))
  const dependencies = {
    now: () => new Date((periodStartEpochSeconds + 60) * 1_000),
    store: {
      loadOriginalIntent: vi.fn().mockResolvedValue(intent),
      persistCycle,
    },
    commercialResolver: {
      resolve: vi.fn().mockResolvedValue(terms),
    },
  }
  return {
    input: {
      providerMode: 'test' as const,
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
      razorpayInvoiceId: invoiceId,
      razorpayOrderId: orderId,
      payment,
      invoice,
      subscription,
    },
    dependencies,
    persistCycle,
  }
}

describe('subscription cycle provider-observation upfront recovery', () => {
  it('reuses the exact coupon-upfront transaction without webhook provenance', async () => {
    const test = upfrontHarness()

    const result = await fulfillSubscriptionCycleProviderObservation(
      test.input,
      test.dependencies,
    )

    expect(result.projectionDisposition).toBe('projected')
    expect(test.persistCycle).toHaveBeenCalledOnce()
    expect(test.persistCycle).toHaveBeenCalledWith({
      completedAt: new Date((periodStartEpochSeconds + 60) * 1_000),
      draft: expect.objectContaining({
        providerSubscriptionStatus: 'authenticated',
        periodStart: new Date(periodStartEpochSeconds * 1_000),
        periodEnd: new Date(periodEndEpochSeconds * 1_000),
        capturedPaise: 49_900,
        discountPaise: 10_000,
      }),
    })
  })

  it('fails closed when only one provider billing bound is present', async () => {
    const test = upfrontHarness({
      billingStartEpochSeconds: periodStartEpochSeconds,
    })

    await expect(
      fulfillSubscriptionCycleProviderObservation(
        test.input,
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(test.persistCycle).not.toHaveBeenCalled()
  })

  it('rejects a conflicting non-empty payment subscription reference', async () => {
    const test = upfrontHarness()
    test.input.payment.subscriptionId = 'sub_ConflictingRecovery123'

    await expect(
      fulfillSubscriptionCycleProviderObservation(
        test.input,
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: 'reference_conflict' })
    expect(test.persistCycle).not.toHaveBeenCalled()
  })
})
