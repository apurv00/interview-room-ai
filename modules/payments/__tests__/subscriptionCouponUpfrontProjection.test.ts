import { describe, expect, it } from 'vitest'
import {
  arbitrateSubscriptionCycleProjection,
  type SubscriptionProjectionArbiterInput,
} from '../services/subscriptionProjectionArbiter'

const checkoutId = '66a111111111111111111111'
const subscriptionId = '66a222222222222222222222'
const userId = '66a333333333333333333333'

function couponUpfrontInput(): SubscriptionProjectionArbiterInput {
  return {
    checkout: {
      id: checkoutId,
      userId,
      providerMode: 'test',
      purpose: 'acquisition',
      leaseLane: 'a',
      planKey: 'plus',
      catalogVersion: 'catalog-v1',
      razorpaySubscriptionId: 'sub_CouponUpfront123',
      requestedStartAtEpochSeconds: 1_702_678_400,
      authorizationExpiresAtEpochSeconds: 1_700_086_400,
      status: 'checkout_opened',
    },
    subscription: {
      id: subscriptionId,
      userId,
      providerMode: 'test',
      planKey: 'plus',
      catalogVersion: 'catalog-v1',
      razorpayPlanId: 'plan_PlusMonthly123',
      razorpaySubscriptionId: 'sub_CouponUpfront123',
      checkoutIntentId: checkoutId,
      leaseLane: 'a',
      requestedStartAtEpochSeconds: 1_702_678_400,
      authorizationExpiresAtEpochSeconds: 1_700_086_400,
      status: 'authenticated',
    },
    cycle: {
      providerMode: 'test',
      subscriptionId,
      razorpaySubscriptionId: 'sub_CouponUpfront123',
      userId,
      planKey: 'plus',
      catalogVersion: 'catalog-v1',
      razorpayPlanId: 'plan_PlusMonthly123',
      periodKey: 'sub_CouponUpfront123:1700000000:1702678400',
      periodStartEpochSeconds: 1_700_000_000,
      periodEndEpochSeconds: 1_702_678_400,
      razorpayInvoiceId: 'inv_CouponUpfront123',
      razorpayPaymentId: 'pay_CouponUpfront123',
      capturedPaise: 49_900,
      currency: 'INR',
      projectionAuthority: 'coupon_upfront',
    },
  }
}

describe('coupon upfront subscription projection', () => {
  it('projects a strictly marked authenticated acquisition through the coupon period', () => {
    expect(
      arbitrateSubscriptionCycleProjection(couponUpfrontInput()),
    ).toMatchObject({
      decision: 'project',
      lineage: 'acquisition',
      reason: 'acquisition_cycle_projects',
      effects: {
        createFinancialRecords: true,
        updateSubscriptionPeriod: true,
        updateUserProjection: true,
      },
    })
  })

  it('does not let an ordinary authenticated subscription grant access', () => {
    const original = couponUpfrontInput()
    const { projectionAuthority: _projectionAuthority, ...cycle } =
      original.cycle
    const input = { ...original, cycle }

    expect(
      arbitrateSubscriptionCycleProjection(input),
    ).toMatchObject({
      decision: 'review',
      reason: 'subscription_status_not_projectable',
    })
  })

  it('rejects coupon-upfront authority when the paid period does not end at the recurring start', () => {
    const original = couponUpfrontInput()
    const input = {
      ...original,
      cycle: {
        ...original.cycle,
        periodEndEpochSeconds:
          original.cycle.periodEndEpochSeconds - 1,
      },
    }

    expect(
      arbitrateSubscriptionCycleProjection(input),
    ).toMatchObject({
      decision: 'review',
      reason: 'subscription_status_not_projectable',
    })
  })
})
