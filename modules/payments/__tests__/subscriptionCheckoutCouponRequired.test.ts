import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  ResolvedCustomerBillingQuote,
} from '../services/customerBillingQuoteService'
import {
  CheckoutCouponCapacityUnavailableError,
} from '../services/checkoutIntentService'
import {
  createSubscriptionCheckout,
  type SubscriptionCheckoutDependencies,
  type StoredSubscriptionCheckoutIntent,
} from '../services/subscriptionCheckoutService'

const userId = new mongoose.Types.ObjectId().toString()
const campaignId = new mongoose.Types.ObjectId().toString()

function quote(withCoupon: boolean): ResolvedCustomerBillingQuote {
  const catalog = {
    version: 'consumer-inr-v1',
    status: 'published',
    contentHash: 'a'.repeat(64),
    content: {
      plans: {
        plus: { razorpayPlanIdByMode: { test: 'plan_plus' } },
      },
    },
  }
  return {
    quote: {
      quoteId: 'quote-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      catalogVersion: catalog.version,
      currency: 'INR',
      gstInclusive: true,
      gstRatePercent: 18,
      listPricePaise: 59_900,
      discountPaise: withCoupon ? 10_000 : 0,
      payablePaise: withCoupon ? 49_900 : 59_900,
      planKey: 'plus',
      disclosure: {
        summary: 'Launch price',
        why: 'Launch offer',
        gst: 'GST included.',
        cancellation: 'Auto-renews until cancelled.',
      },
      entitlementSummary: {},
    },
    context: {
      buyerExists: true,
      activeCatalogVersion: catalog.version,
      sellingMode: 'qa',
      couponMode: withCoupon ? 'qa' : 'off',
      qaUserIds: [userId],
      catalog,
    },
    catalog,
    providerMode: 'test',
    ...(withCoupon
      ? {
          selectedCandidate: {
            campaignId,
            campaignKey: 'launch',
            mode: 'automatic' as const,
            revision: 1,
            status: 'active',
            contentHash: 'b'.repeat(64),
            terms: {
              discountPaise: 10_000,
              applicablePlanKeys: ['plus' as const],
              discountedBillingCycles: 1,
              priority: 100,
              eligibility: {
                newCustomerOnly: false,
                userIds: [],
                segments: ['all' as const],
                acquisitionSources: [],
                upgradesEligible: false,
              },
              maxRedemptionsPerUser: 1,
              minPayablePaiseByPlan: { plus: 39_900 },
              reservationTtlHours: 24,
              visibility: ['checkout' as const],
              termsText: 'First month only.',
            },
            availability: {
              providerMode: 'test' as const,
              redemptions: 0,
              openReservations: 0,
              userRedemptions: 0,
              userOpenReservations: 0,
            },
          },
        }
      : {}),
  } as unknown as ResolvedCustomerBillingQuote
}

function dependencies(
  resolved: ResolvedCustomerBillingQuote,
): SubscriptionCheckoutDependencies & {
  createIntent: ReturnType<typeof vi.fn>
} {
  return {
    resolveSaleContext: vi.fn(async () => ({
      providerMode: 'test',
      buyerSnapshot: {
        name: 'Founder',
        email: 'founder@example.invalid',
        billingProfileVersion: 1,
        billingProfileContentHash: 'c'.repeat(64),
        placeOfSupply: { stateCode: '27', countryCode: 'IN' },
      },
    })),
    supersedeBlockingCheckout: vi.fn(async () => ({ outcome: 'none' })),
    resolveQuote: vi.fn(async () => resolved),
    preflightQuote: vi.fn(async () => ({
      couponAccepted: Boolean(resolved.selectedCandidate),
    })),
    createIntent: vi.fn(),
  }
}

describe('subscription launch coupon fallback', () => {
  it('reopens the exact pending same-plan checkout without creating another intent', async () => {
    const deps = dependencies(quote(false))
    const intentId = new mongoose.Types.ObjectId()
    const remoteId = 'sub_existingPlus123'
    const stored: StoredSubscriptionCheckoutIntent = {
      id: intentId,
      userId: new mongoose.Types.ObjectId(userId),
      kind: 'subscription',
      providerMode: 'test',
      status: 'remote_created',
      purpose: 'acquisition',
      leaseLane: 'a',
      authorizationExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      planKey: 'plus',
      catalogVersion: 'consumer-inr-v1',
      idempotencyKey: 'launch:original-checkout',
      requestHash: 'f'.repeat(64),
      receipt: 'receipt_existing_plus',
      quote: {
        currency: 'INR',
        listPricePaise: 59_900,
        discountPaise: 0,
        payablePaise: 59_900,
        renewalPricePaise: 59_900,
        subscriptionTotalCount: 1_200,
        gst: {
          inclusive: true,
          rateBps: 1_800,
          componentAllocation: 'unallocated',
        },
        entitlementSnapshot: {},
      },
      buyerSnapshot: {},
      razorpaySubscriptionId: remoteId,
      createdAt: new Date('2026-08-07T10:00:00.000Z'),
    }
    deps.supersedeBlockingCheckout = vi.fn(async () => ({
      outcome: 'reusable' as const,
      intentId: intentId.toHexString(),
      planKey: 'plus' as const,
    }))
    deps.loadIntent = vi.fn(async () => stored)
    deps.commercialResolver = {
      resolve: vi.fn(async () => ({
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
            premiumResumeLimit: 5,
            razorpayPlanId: 'plan_plus',
          },
        },
      })),
    }
    deps.createRemote = vi.fn(async () => ({
      intentId: intentId.toHexString(),
      providerMode: 'test' as const,
      kind: 'subscription' as const,
      remoteId,
      source: 'existing' as const,
      reused: true,
    }))
    deps.loadKeyId = vi.fn(() => 'rzp_test_checkoutkey')

    await expect(createSubscriptionCheckout({
      userId,
      idempotencyKey: 'launch:new-browser-key',
      request: { planKey: 'plus' },
    }, deps)).resolves.toMatchObject({
      intentId: intentId.toHexString(),
      reused: true,
      checkout: {
        keyId: 'rzp_test_checkoutkey',
        subscriptionId: remoteId,
      },
      quote: {
        planKey: 'plus',
        payablePaise: 59_900,
      },
    })

    expect(deps.resolveQuote).not.toHaveBeenCalled()
    expect(deps.createIntent).not.toHaveBeenCalled()
    expect(deps.createRemote).toHaveBeenCalledOnce()
  })

  it('supersedes an older different-plan checkout before resolving a new quote', async () => {
    const deps = dependencies(quote(false))
    const callOrder: string[] = []
    deps.resolveSaleContext = vi.fn(async () => {
      callOrder.push('sale')
      return {
        providerMode: 'test',
        buyerSnapshot: {
          name: 'Founder',
          email: 'founder@example.invalid',
          billingProfileVersion: 1,
          billingProfileContentHash: 'c'.repeat(64),
          placeOfSupply: { stateCode: '27', countryCode: 'IN' },
        },
      }
    })
    deps.supersedeBlockingCheckout = vi.fn(async () => {
      callOrder.push('supersede')
      return { outcome: 'none' }
    })
    deps.resolveQuote = vi.fn(async () => {
      callOrder.push('quote')
      return quote(false)
    })
    deps.createIntent.mockRejectedValueOnce(new Error('stop after ordering'))

    await expect(createSubscriptionCheckout({
      userId,
      idempotencyKey: 'launch:supersession-order',
      request: { planKey: 'plus' },
    }, deps)).rejects.toMatchObject({
      code: 'persistence_conflict',
    })

    expect(callOrder).toEqual(['sale', 'supersede', 'quote'])
    expect(deps.supersedeBlockingCheckout).toHaveBeenCalledTimes(1)
  })

  it('persists the authoritative list price when no coupon applies', async () => {
    const deps = dependencies(quote(false))
    deps.createIntent.mockResolvedValueOnce({
      intentId: new mongoose.Types.ObjectId().toString(),
      receipt: 'receipt_list_price',
      requestHash: 'd'.repeat(64),
      status: 'created',
      reused: false,
    })
    deps.loadIntent = vi.fn(async () => null)

    await expect(createSubscriptionCheckout({
      userId,
      idempotencyKey: 'launch:list-price',
      request: { planKey: 'plus' },
    }, deps)).rejects.toMatchObject({
      code: 'persistence_conflict',
    })

    expect(deps.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteSnapshot: expect.objectContaining({
          listPricePaise: 59_900,
          discountPaise: 0,
          payablePaise: 59_900,
        }),
      }),
    )
    expect(deps.createIntent.mock.calls[0]?.[0])
      .not.toHaveProperty('couponReservation')
  })

  it('persists the selected automatic coupon and discounted price', async () => {
    const deps = dependencies(quote(true))
    deps.createIntent.mockResolvedValueOnce({
      intentId: new mongoose.Types.ObjectId().toString(),
      receipt: 'receipt_discounted',
      requestHash: 'e'.repeat(64),
      status: 'created',
      reused: false,
    })
    deps.loadIntent = vi.fn(async () => null)

    await expect(createSubscriptionCheckout({
      userId,
      idempotencyKey: 'launch:automatic-coupon',
      request: { planKey: 'plus' },
    }, deps)).rejects.toMatchObject({
      code: 'persistence_conflict',
    })

    expect(deps.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteSnapshot: expect.objectContaining({
          listPricePaise: 59_900,
          discountPaise: 10_000,
          payablePaise: 49_900,
        }),
        couponReservation: expect.objectContaining({
          campaignId,
          campaignRevision: 1,
          campaignModeSnapshot: 'automatic',
          discountPaise: 10_000,
          discountedBillingCycles: 1,
        }),
      }),
    )
  })

  it('does not retry at list price when coupon capacity is exhausted', async () => {
    const deps = dependencies(quote(true))
    deps.createIntent.mockRejectedValueOnce(
      new CheckoutCouponCapacityUnavailableError('global_cap_exhausted'),
    )

    await expect(createSubscriptionCheckout({
      userId,
      idempotencyKey: 'launch:capacity-exhausted',
      request: { planKey: 'plus' },
    }, deps)).rejects.toMatchObject({
      code: 'commercial_unavailable',
    })

    expect(deps.createIntent).toHaveBeenCalledTimes(1)
    expect(deps.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteSnapshot: expect.objectContaining({
          discountPaise: 10_000,
          payablePaise: 49_900,
        }),
        couponReservation: expect.objectContaining({
          campaignId,
          discountPaise: 10_000,
        }),
      }),
    )
  })
})
