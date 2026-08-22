import { describe, expect, it, vi } from 'vitest'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import {
  createRazorpayPaymentBindingVerifier,
} from '../providers/razorpayBindingVerifier'
import type {
  RazorpayClientFactory,
} from '../providers/razorpayClientFactory'
import {
  createRazorpayServerAdapter,
  type RazorpaySdkPort,
  type RazorpaySubscriptionCreatePayload,
} from '../providers/razorpayServerAdapter'
import { validateCouponTerms } from '../services/couponValidation'
import type {
  CatalogContent,
  CouponRevisionTerms,
} from '../types/catalog'

const now = new Date('2026-08-05T12:00:00.000Z')

function rawSubscription() {
  return {
    id: 'sub_Coupon123',
    entity: 'subscription',
    plan_id: 'plan_Plus123',
    offer_id: null,
    customer_id: null,
    status: 'created',
    total_count: 12,
    paid_count: 0,
    remaining_count: 12,
    current_start: null,
    current_end: null,
    start_at: 1_786_121_600,
    end_at: null,
    charge_at: 1_786_121_600,
    expire_by: 1_783_529_999,
    ended_at: null,
    has_scheduled_changes: false,
    change_scheduled_at: null,
    notes: {
      checkout_receipt: 'ipr_coupon_test',
    },
    created_at: 1_783_526_400,
  }
}

function subscriptionSdk() {
  const create = vi.fn(
    async (_input: RazorpaySubscriptionCreatePayload) => rawSubscription(),
  )
  const sdk = {
    subscriptions: {
      create,
      all: vi.fn(),
      fetch: vi.fn(),
    },
  } as unknown as RazorpaySdkPort
  return { sdk, create }
}

function couponTerms(
  overrides: Partial<CouponRevisionTerms> = {},
): CouponRevisionTerms {
  return {
    discountPaise: 10_000,
    applicablePlanKeys: ['plus'],
    discountedBillingCycles: 1,
    razorpayOfferIdByMode: {},
    priority: 0,
    eligibility: {
      newCustomerOnly: false,
      userIds: [],
      segments: ['all'],
      acquisitionSources: [],
      upgradesEligible: false,
    },
    maxRedemptionsPerUser: 1,
    minPayablePaiseByPlan: {},
    reservationTtlHours: 24,
    visibility: ['checkout'],
    termsText: 'First billing cycle only; renews at list price thereafter.',
    ...overrides,
  }
}

const couponCatalog = {
  plans: {
    plus: { listPricePaise: 59_900 },
    pro: { listPricePaise: 99_900 },
  },
} as CatalogContent

describe('Razorpay upfront subscription item', () => {
  it('maps one CMS-priced item to addons on a future-start subscription', async () => {
    const harness = subscriptionSdk()
    const adapter = createRazorpayServerAdapter({
      providerMode: 'test',
      sdk: harness.sdk,
    })

    await adapter.createSubscription({
      planId: 'plan_Plus123',
      totalCount: 12,
      upfrontItem: {
        name: 'Plus first billing cycle',
        amountPaise: 49_900,
        currency: 'INR',
      },
      startAtEpochSeconds: 1_786_121_600,
      authorizationExpiresAtEpochSeconds: 1_783_529_999,
      customerNotify: false,
      receipt: 'ipr_coupon_test',
      notes: {},
    })

    expect(harness.create).toHaveBeenCalledWith({
      plan_id: 'plan_Plus123',
      total_count: 12,
      customer_notify: false,
      addons: [{
        item: {
          name: 'Plus first billing cycle',
          amount: 49_900,
          currency: 'INR',
        },
      }],
      start_at: 1_786_121_600,
      expire_by: 1_783_529_999,
      notes: { checkout_receipt: 'ipr_coupon_test' },
    })
    expect(harness.create.mock.calls[0]?.[0]).not.toHaveProperty('offer_id')
  })

  it('rejects combining an upfront item with a legacy Offer binding', async () => {
    const harness = subscriptionSdk()
    const adapter = createRazorpayServerAdapter({
      providerMode: 'test',
      sdk: harness.sdk,
    })

    await expect(adapter.createSubscription({
      planId: 'plan_Plus123',
      totalCount: 12,
      offerId: 'offer_Legacy123',
      upfrontItem: {
        name: 'Plus first billing cycle',
        amountPaise: 49_900,
        currency: 'INR',
      },
      startAtEpochSeconds: 1_786_121_600,
      authorizationExpiresAtEpochSeconds: 1_783_529_999,
      customerNotify: false,
      receipt: 'ipr_coupon_test',
      notes: {},
    })).rejects.toThrow(
      'Upfront subscription items cannot be combined with an Offer',
    )
    expect(harness.create).not.toHaveBeenCalled()
  })
})

describe('Razorpay subscription boundary normalization', () => {
  it('accepts zero-length boundaries returned for an immediately cancelled subscription', async () => {
    const boundary = 1_786_121_600
    const sdk = {
      subscriptions: {
        create: vi.fn(),
        all: vi.fn(),
        fetch: vi.fn().mockResolvedValue({
          ...rawSubscription(),
          status: 'cancelled',
          current_start: boundary,
          current_end: boundary,
          start_at: boundary,
          end_at: boundary,
          ended_at: boundary - 1,
        }),
      },
    } as unknown as RazorpaySdkPort
    const adapter = createRazorpayServerAdapter({
      providerMode: 'test',
      sdk,
    })

    await expect(adapter.fetchSubscription('sub_Coupon123')).resolves
      .toMatchObject({
        status: 'cancelled',
        currentStartEpochSeconds: boundary,
        currentEndEpochSeconds: boundary,
        startAtEpochSeconds: boundary,
        endAtEpochSeconds: boundary,
      })
  })

  it('still rejects a subscription boundary that moves backwards', async () => {
    const boundary = 1_786_121_600
    const sdk = {
      subscriptions: {
        create: vi.fn(),
        all: vi.fn(),
        fetch: vi.fn().mockResolvedValue({
          ...rawSubscription(),
          status: 'cancelled',
          start_at: boundary,
          end_at: boundary - 1,
        }),
      },
    } as unknown as RazorpaySdkPort
    const adapter = createRazorpayServerAdapter({
      providerMode: 'test',
      sdk,
    })

    await expect(adapter.fetchSubscription('sub_Coupon123')).rejects
      .toThrow('Subscription end must not precede its start')
  })
})

describe('CMS coupon binding verification', () => {
  it('verifies canonical terms and complete Plan IDs without provider reads', async () => {
    const forMode = vi.fn(() => {
      throw new Error('Provider lookup must not run for CMS coupon terms')
    })
    const verifier = createRazorpayPaymentBindingVerifier({
      clientFactory: { forMode } as RazorpayClientFactory,
      now: () => new Date(now),
    })
    const terms = couponTerms({
      applicablePlanKeys: ['plus', 'pro'],
    })
    const contentHash = sha256CanonicalJson(terms)

    await expect(verifier.verifyCoupon({
      mode: 'test',
      terms,
      contentHash,
      catalogContentHash: 'a'.repeat(64),
      applicablePlanIds: ['plan_Plus123', 'plan_Pro123'],
    })).resolves.toEqual({
      status: 'verified',
      fetchedAt: now,
      normalizedTermsHash: contentHash,
      errors: [],
    })
    expect(forMode).not.toHaveBeenCalled()
  })

  it('fails closed when an applicable catalog Plan ID is missing', async () => {
    const forMode = vi.fn()
    const verifier = createRazorpayPaymentBindingVerifier({
      clientFactory: { forMode } as RazorpayClientFactory,
      now: () => new Date(now),
    })
    const terms = couponTerms({
      applicablePlanKeys: ['plus', 'pro'],
    })

    const result = await verifier.verifyCoupon({
      mode: 'test',
      terms,
      contentHash: sha256CanonicalJson(terms),
      catalogContentHash: 'a'.repeat(64),
      applicablePlanIds: ['plan_Plus123'],
    })

    expect(result.status).toBe('failed')
    expect(result.errors).toContain(
      'Coupon verification requires every mode-specific catalog Plan binding',
    )
    expect(forMode).not.toHaveBeenCalled()
  })

  it('fails closed when the CMS terms hash is not canonical', async () => {
    const forMode = vi.fn()
    const verifier = createRazorpayPaymentBindingVerifier({
      clientFactory: { forMode } as RazorpayClientFactory,
      now: () => new Date(now),
    })
    const terms = couponTerms()

    const result = await verifier.verifyCoupon({
      mode: 'test',
      terms,
      contentHash: 'b'.repeat(64),
      catalogContentHash: 'a'.repeat(64),
      applicablePlanIds: ['plan_Plus123'],
    })

    expect(result.status).toBe('failed')
    expect(result.errors).toContain(
      'Coupon terms do not match their canonical contentHash',
    )
    expect(forMode).not.toHaveBeenCalled()
  })
})

describe('launch coupon validation', () => {
  it('accepts a one-cycle acquisition coupon without an Offer warning', () => {
    const result = validateCouponTerms(couponTerms(), couponCatalog)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('rejects multi-cycle discounts and upgrade eligibility', () => {
    const result = validateCouponTerms(couponTerms({
      discountedBillingCycles: 2,
      eligibility: {
        ...couponTerms().eligibility,
        upgradesEligible: true,
      },
    }), couponCatalog)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'Launch coupons must discount exactly 1 billing cycle',
      'Launch coupons cannot apply to subscription upgrades',
    ]))
  })
})
