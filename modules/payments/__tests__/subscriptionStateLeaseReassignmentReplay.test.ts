import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type { RazorpaySubscriptionDto } from '../providers/razorpayServerAdapter'
import {
  persistSubscriptionProviderObservation,
  type SubscriptionStateCheckoutIntent,
  type SubscriptionStateLocalSubscription,
  type SubscriptionStatePersistenceStore,
  type SubscriptionStatePersistenceTransaction,
} from '../services/subscriptionStatePersistenceService'

const USER_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439101')
const OLD_INTENT_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439102',
)
const OLD_SUBSCRIPTION_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439103',
)
const NEW_INTENT_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439104',
)
const CURRENT_LEASE_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439105',
)
const CAMPAIGN_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439106',
)
const CREATED_AT = new Date('2026-08-07T05:45:00.000Z')
const AUTHORIZATION_EXPIRES_AT = new Date('2026-08-08T05:45:00.000Z')
const OBSERVED_AT = new Date('2026-08-07T05:51:25.000Z')
const OLD_REMOTE_ID = 'sub_OldUnpaidCheckout123'
const NEW_REMOTE_ID = 'sub_NewCheckout456'
const PLAN_ID = 'plan_ProMonthly123'
const RECEIPT = 'subscription-old-unpaid-123'

function intent(): SubscriptionStateCheckoutIntent {
  return {
    id: OLD_INTENT_ID,
    userId: USER_ID,
    kind: 'subscription',
    providerMode: 'live',
    status: 'cancelled',
    purpose: 'acquisition',
    leaseLane: 'a',
    authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
    planKey: 'pro',
    catalogVersion: 'consumer-inr-2026-08-v1-razorpay-live',
    razorpaySubscriptionId: OLD_REMOTE_ID,
    receipt: RECEIPT,
    createdAt: CREATED_AT,
    quote: {
      currency: 'INR',
      listPricePaise: 99_900,
      discountPaise: 10_000,
      payablePaise: 89_900,
      renewalPricePaise: 99_900,
      discountedBillingCycles: 1,
      couponCampaignId: CAMPAIGN_ID,
      couponCampaignRevision: 1,
    },
  }
}

function localSubscription(): SubscriptionStateLocalSubscription {
  return {
    id: OLD_SUBSCRIPTION_ID,
    userId: USER_ID,
    providerMode: 'live',
    planKey: 'pro',
    catalogVersion: 'consumer-inr-2026-08-v1-razorpay-live',
    razorpayPlanId: PLAN_ID,
    razorpaySubscriptionId: OLD_REMOTE_ID,
    checkoutIntentId: OLD_INTENT_ID,
    leaseLane: 'a',
    authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
    status: 'cancelled',
    couponCampaignId: CAMPAIGN_ID,
    discountedCyclesRemaining: 1,
    source: 'customer',
  }
}

function remoteSubscription(): RazorpaySubscriptionDto {
  return {
    providerMode: 'live',
    id: OLD_REMOTE_ID,
    planId: PLAN_ID,
    status: 'cancelled',
    totalCount: 1_200,
    paidCount: 0,
    remainingCount: 1_200,
    authorizationExpiresAtEpochSeconds:
      AUTHORIZATION_EXPIRES_AT.getTime() / 1_000,
    endedAtEpochSeconds: OBSERVED_AT.getTime() / 1_000,
    notes: {
      checkout_receipt: RECEIPT,
      checkout_intent_id: OLD_INTENT_ID.toHexString(),
      catalog_version: 'consumer-inr-2026-08-v1-razorpay-live',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: CREATED_AT.getTime() / 1_000,
  }
}

function commercialTerms() {
  return {
    catalog: {
      version: 'consumer-inr-2026-08-v1-razorpay-live',
      contentHash: 'a'.repeat(64),
      status: 'published' as const,
      effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      integrityVerified: true,
      plan: {
        key: 'pro' as const,
        listPricePaise: 99_900,
        billingPeriod: 'monthly' as const,
        interviewLimit: 15,
        interviewPeriodOwner: 'razorpay_billing_cycle' as const,
        maxInterviewDurationMinutes: 30,
        basicSavedResumeLimit: 1,
        premiumResumeLimit: 15,
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
      applicablePlanKeys: ['pro' as const],
      discountedBillingCycles: 1,
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
      termsText: 'First billing cycle only.',
    },
  }
}

function harness(currentLaneLease: Awaited<ReturnType<
  SubscriptionStatePersistenceTransaction['loadCurrentLaneLease']
>>) {
  const oldIntent = intent()
  const oldSubscription = localSubscription()
  const transaction: SubscriptionStatePersistenceTransaction = {
    loadIntent: vi.fn().mockResolvedValue(oldIntent),
    loadSubscription: vi.fn().mockResolvedValue(oldSubscription),
    loadLease: vi.fn().mockResolvedValue(null),
    loadCurrentLaneLease: vi.fn().mockResolvedValue(currentLaneLease),
    createSubscription: vi.fn(),
    updateSubscriptionStatus: vi.fn(),
    updateIntentStatus: vi.fn(),
    recordTerminalLease: vi.fn(),
    releaseCouponReservation: vi.fn().mockResolvedValue(false),
  }
  const store: SubscriptionStatePersistenceStore = {
    loadOriginalIntent: vi.fn().mockResolvedValue(oldIntent),
    runTransaction: vi.fn(async (work) => work(transaction)),
  }
  return { oldIntent, oldSubscription, transaction, store }
}

function observation(harnessResult: ReturnType<typeof harness>) {
  return persistSubscriptionProviderObservation({
    providerMode: 'live',
    providerObservedAt: OBSERVED_AT,
    razorpaySubscriptionId: OLD_REMOTE_ID,
    subscription: remoteSubscription(),
    localContext: {
      checkout: {
        _id: OLD_INTENT_ID,
        userId: USER_ID,
        providerMode: 'live',
        status: 'cancelled',
        purpose: 'acquisition',
        leaseLane: 'a',
        authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
        planKey: 'pro',
        catalogVersion: 'consumer-inr-2026-08-v1-razorpay-live',
        razorpaySubscriptionId: OLD_REMOTE_ID,
        receipt: RECEIPT,
      },
      subscription: {
        _id: OLD_SUBSCRIPTION_ID,
        userId: USER_ID,
        providerMode: 'live',
        planKey: 'pro',
        catalogVersion: 'consumer-inr-2026-08-v1-razorpay-live',
        razorpayPlanId: PLAN_ID,
        razorpaySubscriptionId: OLD_REMOTE_ID,
        checkoutIntentId: OLD_INTENT_ID,
        leaseLane: 'a',
        authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
        status: 'cancelled',
        source: 'customer',
      },
    },
  }, {
    store: harnessResult.store,
    commercialResolver: {
      resolve: vi.fn().mockResolvedValue(commercialTerms()),
    },
    now: () => OBSERVED_AT,
  })
}

describe('terminal subscription replay after lease reassignment', () => {
  it('acknowledges the exact old cancellation without touching the new lease', async () => {
    const currentLaneLease = {
      id: CURRENT_LEASE_ID,
      userId: USER_ID,
      providerMode: 'live' as const,
      lane: 'a' as const,
      ownerCheckoutIntentId: NEW_INTENT_ID,
      razorpaySubscriptionId: NEW_REMOTE_ID,
      status: 'held' as const,
    }
    const test = harness(currentLaneLease)

    await expect(observation(test)).resolves.toMatchObject({
      outcome: 'handled',
      checkoutIntentId: OLD_INTENT_ID.toHexString(),
      localSubscriptionId: OLD_SUBSCRIPTION_ID.toHexString(),
      checkoutIntentStatus: 'cancelled',
      subscriptionStatus: 'cancelled',
      leaseStatus: 'released',
      reused: true,
    })

    expect(test.transaction.recordTerminalLease).not.toHaveBeenCalled()
    expect(test.transaction.updateIntentStatus).not.toHaveBeenCalled()
    expect(test.transaction.updateSubscriptionStatus).not.toHaveBeenCalled()
  })

  it('still fails closed when the old lease is simply missing', async () => {
    const test = harness(null)

    await expect(observation(test)).rejects.toMatchObject({
      code: 'local_context_missing',
    })
  })
})
