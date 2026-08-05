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
                upgradesEligible: true,
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
    resolveQuote: vi.fn(async () => resolved),
    preflightQuote: vi.fn(async () => ({
      couponAccepted: Boolean(resolved.selectedCandidate),
    })),
    createIntent: vi.fn(),
  }
}

describe('subscription launch coupon fallback', () => {
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
