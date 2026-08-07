import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  RazorpayInvoiceDto,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import {
  supersedeBlockingUnpaidSubscriptionCheckout,
  type BlockingSubscriptionCheckout,
  type UnpaidSubscriptionCheckoutSupersessionDependencies,
} from '../services/unpaidSubscriptionCheckoutSupersessionService'

const USER_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439001')
const INTENT_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439002')
const CAMPAIGN_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439003')
const CREATED_AT = new Date('2026-08-07T10:00:00.000Z')
const AUTHORIZATION_EXPIRES_AT = new Date('2026-08-07T10:15:00.000Z')
const START_AT = new Date('2026-08-07T11:00:00.000Z')
const REQUEST_STARTED_AT = new Date('2026-08-07T12:00:00.000Z')
const OBSERVED_AT = new Date('2026-08-07T12:00:01.000Z')
const REMOTE_ID = 'sub_AbandonedPlus123'
const PLAN_ID = 'plan_PlusMonthly123'
const RECEIPT = 'subscription-receipt-123'

function blockingCheckout(
  overrides: Partial<BlockingSubscriptionCheckout> = {},
): BlockingSubscriptionCheckout {
  const intent: BlockingSubscriptionCheckout['intent'] = {
    id: INTENT_ID,
    userId: USER_ID,
    kind: 'subscription',
    providerMode: 'test',
    status: 'remote_created',
    purpose: 'acquisition',
    leaseLane: 'a',
    requestedStartAt: START_AT,
    authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
    planKey: 'plus',
    catalogVersion: 'consumer-inr-v1',
    razorpaySubscriptionId: REMOTE_ID,
    receipt: RECEIPT,
    createdAt: CREATED_AT,
    quote: {
      currency: 'INR',
      listPricePaise: 59_900,
      discountPaise: 10_000,
      payablePaise: 49_900,
      renewalPricePaise: 59_900,
      discountedBillingCycles: 1,
      couponCampaignId: CAMPAIGN_ID,
      couponCampaignRevision: 1,
    },
  }
  return {
    lease: {
      userId: USER_ID,
      providerMode: 'test',
      lane: 'a',
      ownerCheckoutIntentId: INTENT_ID,
      razorpaySubscriptionId: REMOTE_ID,
      status: 'held',
    },
    intent,
    hasLocalPaymentEvidence: false,
    ...overrides,
  }
}

function providerSubscription(
  status: RazorpaySubscriptionDto['status'],
): RazorpaySubscriptionDto {
  return {
    providerMode: 'test',
    id: REMOTE_ID,
    planId: PLAN_ID,
    status,
    totalCount: 1_200,
    paidCount: 0,
    remainingCount: 1_200,
    startAtEpochSeconds: START_AT.getTime() / 1_000,
    authorizationExpiresAtEpochSeconds:
      AUTHORIZATION_EXPIRES_AT.getTime() / 1_000,
    ...(status === 'cancelled' || status === 'expired'
      ? { endedAtEpochSeconds: OBSERVED_AT.getTime() / 1_000 }
      : {}),
    notes: {
      checkout_receipt: RECEIPT,
      checkout_intent_id: INTENT_ID.toHexString(),
      catalog_version: 'consumer-inr-v1',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: CREATED_AT.getTime() / 1_000,
  }
}

function localContext() {
  return {
    checkout: {
      _id: INTENT_ID,
      userId: USER_ID,
      providerMode: 'test' as const,
      status: 'remote_created' as const,
      purpose: 'acquisition' as const,
      leaseLane: 'a' as const,
      requestedStartAt: START_AT,
      authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
      planKey: 'plus' as const,
      catalogVersion: 'consumer-inr-v1',
      razorpaySubscriptionId: REMOTE_ID,
      receipt: RECEIPT,
    },
  }
}

function commercialTerms() {
  return {
    catalog: {
      version: 'consumer-inr-v1',
      contentHash: 'a'.repeat(64),
      status: 'published' as const,
      effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      integrityVerified: true,
      plan: {
        key: 'plus' as const,
        listPricePaise: 59_900,
        billingPeriod: 'monthly' as const,
        interviewLimit: 10,
        interviewPeriodOwner: 'razorpay_billing_cycle' as const,
        maxInterviewDurationMinutes: 30,
        basicSavedResumeLimit: 1,
        premiumResumeLimit: 3,
        razorpayPlanId: PLAN_ID,
      },
    },
    coupon: {
      campaignId: CAMPAIGN_ID,
      revision: 1,
      status: 'active' as const,
      contentHash: 'b'.repeat(64),
      integrityVerified: true,
      discountPaise: 10_000,
      applicablePlanKeys: ['plus' as const],
      discountedBillingCycles: 1,
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
      termsText: 'First billing cycle only.',
    },
  }
}

function dependencies(input: {
  remote?: RazorpaySubscriptionDto
  invoices?: RazorpayInvoiceDto[]
} = {}): UnpaidSubscriptionCheckoutSupersessionDependencies & {
  cancelSubscriptionImmediately: ReturnType<typeof vi.fn>
  fetchSubscription: ReturnType<typeof vi.fn>
  fetchSubscriptionInvoices: ReturnType<typeof vi.fn>
  fetchPayment: ReturnType<typeof vi.fn>
  persistObservation: ReturnType<typeof vi.fn>
} {
  const remote = input.remote ?? providerSubscription('created')
  const cancelSubscriptionImmediately = vi.fn().mockResolvedValue(
    providerSubscription('cancelled'),
  )
  const fetchSubscription = vi.fn().mockResolvedValue(remote)
  const fetchSubscriptionInvoices = vi.fn().mockResolvedValue(
    input.invoices ?? [],
  )
  const fetchPayment = vi.fn()
  const persistObservation = vi.fn().mockResolvedValue({
    checkoutIntentId: INTENT_ID.toHexString(),
    checkoutIntentStatus: 'cancelled',
    leaseStatus: 'released',
  })
  return {
    store: {
      loadBlockingCheckout: vi.fn().mockResolvedValue(blockingCheckout()),
    },
    cancellationClientFactory: {
      forMode: vi.fn().mockReturnValue({
        fetchSubscription,
        cancelSubscriptionImmediately,
      }),
    } as never,
    clientFactory: {
      forMode: vi.fn().mockReturnValue({
        fetchSubscriptionInvoices,
        fetchPayment,
      }),
    } as never,
    mappingStore: {
      loadOneTimeIntentByOrder: vi.fn(),
      loadSubscriptionContext: vi.fn().mockResolvedValue(localContext()),
    },
    commercialResolver: {
      resolve: vi.fn().mockResolvedValue(commercialTerms()),
    },
    persistObservation,
    now: () => OBSERVED_AT,
    cancelSubscriptionImmediately,
    fetchSubscription,
    fetchSubscriptionInvoices,
    fetchPayment,
  }
}

async function supersede(
  deps: UnpaidSubscriptionCheckoutSupersessionDependencies,
) {
  return supersedeBlockingUnpaidSubscriptionCheckout({
    userId: USER_ID.toHexString(),
    providerMode: 'test',
    replacementPlanKey: 'pro',
    requestStartedAt: REQUEST_STARTED_AT,
  }, deps)
}

describe('unpaid subscription checkout supersession', () => {
  it('cancels an exact created Plus checkout and releases it before Pro', async () => {
    const deps = dependencies()

    await expect(supersede(deps)).resolves.toEqual({
      outcome: 'superseded',
      intentId: INTENT_ID.toHexString(),
      previousPlanKey: 'plus',
      providerStatus: 'cancelled',
    })

    expect(deps.cancelSubscriptionImmediately).toHaveBeenCalledWith(REMOTE_ID)
    expect(deps.fetchSubscriptionInvoices).toHaveBeenCalledTimes(2)
    expect(deps.persistObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'test',
        razorpaySubscriptionId: REMOTE_ID,
        subscription: expect.objectContaining({ status: 'cancelled' }),
      }),
      expect.objectContaining({ now: expect.any(Function) }),
    )
  })

  it('reconciles an already-expired unpaid checkout without cancelling again', async () => {
    const deps = dependencies({
      remote: providerSubscription('expired'),
    })

    await expect(supersede(deps)).resolves.toMatchObject({
      outcome: 'superseded',
      providerStatus: 'expired',
    })

    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.fetchSubscriptionInvoices).toHaveBeenCalledTimes(2)
    expect(deps.persistObservation).toHaveBeenCalledTimes(1)
  })

  it('returns an exact unexpired same-plan checkout for server-side reuse', async () => {
    const deps = dependencies()

    await expect(supersedeBlockingUnpaidSubscriptionCheckout({
      userId: USER_ID.toHexString(),
      providerMode: 'test',
      replacementPlanKey: 'plus',
      requestStartedAt: new Date('2026-08-07T10:05:00.000Z'),
    }, deps)).resolves.toEqual({
      outcome: 'reusable',
      intentId: INTENT_ID.toHexString(),
      planKey: 'plus',
    })

    expect(deps.fetchSubscription).toHaveBeenCalledWith(REMOTE_ID)
    expect(deps.fetchSubscriptionInvoices).toHaveBeenCalledOnce()
    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.persistObservation).not.toHaveBeenCalled()
  })

  it('releases an expired same-plan checkout instead of reopening it', async () => {
    const deps = dependencies({
      remote: providerSubscription('expired'),
    })

    await expect(supersedeBlockingUnpaidSubscriptionCheckout({
      userId: USER_ID.toHexString(),
      providerMode: 'test',
      replacementPlanKey: 'plus',
      requestStartedAt: REQUEST_STARTED_AT,
    }, deps)).resolves.toMatchObject({
      outcome: 'superseded',
      previousPlanKey: 'plus',
      providerStatus: 'expired',
    })

    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.persistObservation).toHaveBeenCalledOnce()
  })

  it('fails closed when Razorpay reports payment evidence', async () => {
    const deps = dependencies({
      invoices: [{
        providerMode: 'test',
        id: 'inv_PaidAttempt123',
        subscriptionId: REMOTE_ID,
        paymentId: 'pay_Captured123',
        orderId: 'order_Captured123',
        status: 'paid',
        amountPaise: 49_900,
        amountPaidPaise: 49_900,
        amountDuePaise: 0,
        currency: 'INR',
        partialPayment: false,
        createdAtEpochSeconds: CREATED_AT.getTime() / 1_000,
      }],
    })

    await expect(supersede(deps)).rejects.toMatchObject({
      code: 'review_required',
    })

    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.persistObservation).not.toHaveBeenCalled()
  })

  it('does not cancel an authenticated subscription', async () => {
    const deps = dependencies({
      remote: providerSubscription('authenticated'),
    })

    await expect(supersede(deps)).rejects.toMatchObject({
      code: 'review_required',
    })

    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.persistObservation).not.toHaveBeenCalled()
  })

  it('leaves the checkout blocked when provider reads are unavailable', async () => {
    const deps = dependencies()
    deps.fetchSubscription.mockRejectedValueOnce(new Error('timeout'))

    await expect(supersede(deps)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })

    expect(deps.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(deps.persistObservation).not.toHaveBeenCalled()
  })

  it('rejects local payment evidence before any Razorpay call', async () => {
    const deps = dependencies()
    deps.store = {
      loadBlockingCheckout: vi.fn().mockResolvedValue(
        blockingCheckout({ hasLocalPaymentEvidence: true }),
      ),
    }

    await expect(supersede(deps)).rejects.toMatchObject({
      code: 'review_required',
    })

    expect(deps.fetchSubscription).not.toHaveBeenCalled()
    expect(deps.persistObservation).not.toHaveBeenCalled()
  })
})
