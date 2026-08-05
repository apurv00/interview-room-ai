import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import {
  initiateCustomerPeriodEndCancellation,
  submitOldSubscriptionPeriodEndCancellation,
} from '../services/subscriptionLifecycleService'
import {
  createRazorpaySubscriptionCancellationAdapter,
} from '../providers/razorpaySubscriptionCancellationAdapter'

const USER_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439001')
const SUBSCRIPTION_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439002',
)
const CHECKOUT_INTENT_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439003',
)
const CAMPAIGN_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439004',
)
const REQUEST_ID = new mongoose.Types.ObjectId(
  '507f1f77bcf86cd799439005',
)
const OBSERVED_AT = new Date('2026-08-05T12:00:00.000Z')
const PERIOD_START = new Date('2026-08-05T11:00:00.000Z')
const PERIOD_END = new Date('2026-09-05T11:00:00.000Z')
const REMOTE_SUBSCRIPTION_ID = 'sub_CouponUpfront123'
const REMOTE_PLAN_ID = 'plan_PlusMonthly123'

function currentCouponSubscription() {
  return {
    _id: SUBSCRIPTION_ID,
    userId: USER_ID,
    providerMode: 'test' as const,
    planKey: 'plus' as const,
    catalogVersion: 'consumer-inr-v1',
    razorpayPlanId: REMOTE_PLAN_ID,
    razorpaySubscriptionId: REMOTE_SUBSCRIPTION_ID,
    checkoutIntentId: CHECKOUT_INTENT_ID,
    leaseLane: 'a' as const,
    requestedStartAt: PERIOD_END,
    status: 'authenticated' as const,
    currentPeriodKey: 'coupon-upfront:2026-08-05',
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    couponCampaignId: CAMPAIGN_ID,
    discountedCyclesRemaining: 0,
  }
}

function cancellationContext() {
  return {
    request: {
      _id: REQUEST_ID,
      userId: USER_ID,
      actorUserId: USER_ID,
      source: 'customer' as const,
      operation: 'period_end_cancel' as const,
      toPlanKey: 'free' as const,
      requestedAt: OBSERVED_AT,
      requestedEffectiveAt: PERIOD_END,
      providerMode: 'test' as const,
      fromSubscriptionId: SUBSCRIPTION_ID,
      fromRazorpaySubscriptionId: REMOTE_SUBSCRIPTION_ID,
      status: 'old_cancellation_pending' as const,
    },
    subscription: currentCouponSubscription(),
  }
}

function terminalProviderSubscription() {
  return {
    providerMode: 'test' as const,
    id: REMOTE_SUBSCRIPTION_ID,
    planId: REMOTE_PLAN_ID,
    status: 'cancelled' as const,
    totalCount: 1_200,
    paidCount: 0,
    remainingCount: 1_200,
    startAtEpochSeconds: PERIOD_END.getTime() / 1_000,
    endedAtEpochSeconds: OBSERVED_AT.getTime() / 1_000,
    notes: {},
    createdAtEpochSeconds: PERIOD_START.getTime() / 1_000,
  }
}

describe('coupon-upfront subscription cancellation', () => {
  it('accepts exact fulfilled coupon access as a cancellable paid period', async () => {
    const persistCancellationRequest = vi.fn().mockResolvedValue({
      planChangeRequestId: REQUEST_ID.toHexString(),
      checkoutIntentId: '',
      effectiveAt: PERIOD_END,
      reused: false,
    })
    const submitCancellation = vi.fn().mockResolvedValue({
      planChangeRequestId: REQUEST_ID.toHexString(),
      status: 'scheduled',
      effectiveAt: PERIOD_END.toISOString(),
      reused: false,
    })

    const result = await initiateCustomerPeriodEndCancellation({
      userId: USER_ID.toHexString(),
      idempotencyKey: 'billing-cancel:coupon-1',
    }, {
      cancellationReady: true,
      now: () => OBSERVED_AT,
      loadCurrentSubscription: vi.fn().mockResolvedValue(
        currentCouponSubscription(),
      ),
      persistCancellationRequest,
      submitCancellation,
    })

    expect(persistCancellationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          status: 'authenticated',
          requestedStartAt: PERIOD_END,
          discountedCyclesRemaining: 0,
        }),
      }),
    )
    expect(result.status).toBe('scheduled')
  })

  it('rejects authenticated mandate state without exact coupon lineage', async () => {
    const persistCancellationRequest = vi.fn()
    await expect(initiateCustomerPeriodEndCancellation({
      userId: USER_ID.toHexString(),
      idempotencyKey: 'billing-cancel:coupon-2',
    }, {
      cancellationReady: true,
      now: () => OBSERVED_AT,
      loadCurrentSubscription: vi.fn().mockResolvedValue({
        ...currentCouponSubscription(),
        couponCampaignId: undefined,
      }),
      persistCancellationRequest,
    })).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    expect(persistCancellationRequest).not.toHaveBeenCalled()
  })

  it('immediately terminates only the future Razorpay renewal mandate', async () => {
    const cancelImmediately = vi.fn().mockResolvedValue(
      terminalProviderSubscription(),
    )
    const cancelAtCycleEnd = vi.fn()
    const commitCancellationAccepted = vi.fn().mockResolvedValue({
      reused: false,
    })

    const result = await submitOldSubscriptionPeriodEndCancellation({
      planChangeRequestId: REQUEST_ID.toHexString(),
      observedAt: OBSERVED_AT,
    }, {
      loadCancellationContext: vi.fn().mockResolvedValue(
        cancellationContext(),
      ),
      cancellationClientFactory: {
        forMode: vi.fn().mockReturnValue({
          cancelSubscriptionImmediately: cancelImmediately,
          cancelSubscriptionAtCycleEnd: cancelAtCycleEnd,
        }),
      } as never,
      commitCancellationAccepted,
    })

    expect(cancelImmediately).toHaveBeenCalledWith(
      REMOTE_SUBSCRIPTION_ID,
    )
    expect(cancelAtCycleEnd).not.toHaveBeenCalled()
    expect(commitCancellationAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ status: 'cancelled' }),
      }),
    )
    expect(result).toMatchObject({
      status: 'scheduled',
      effectiveAt: PERIOD_END.toISOString(),
    })
  })
})

describe('immediate Razorpay cancellation recovery', () => {
  const activeRaw = {
    id: REMOTE_SUBSCRIPTION_ID,
    entity: 'subscription' as const,
    plan_id: REMOTE_PLAN_ID,
    offer_id: null,
    status: 'authenticated' as const,
    total_count: 1_200,
    paid_count: 0,
    remaining_count: 1_200,
    start_at: PERIOD_END.getTime() / 1_000,
    notes: {},
    created_at: PERIOD_START.getTime() / 1_000,
  }

  it('recovers already-terminal provider evidence after an idempotent cancel error', async () => {
    const cancel = vi.fn().mockRejectedValue(
      new Error('subscription is already cancelled'),
    )
    const fetch = vi.fn().mockResolvedValue({
      ...activeRaw,
      status: 'cancelled',
      ended_at: OBSERVED_AT.getTime() / 1_000,
    })
    const adapter = createRazorpaySubscriptionCancellationAdapter({
      providerMode: 'test',
      sdk: { subscriptions: { fetch, cancel } },
    })

    await expect(
      adapter.cancelSubscriptionImmediately(REMOTE_SUBSCRIPTION_ID),
    ).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('recovers an ambiguous cancel response by fetching terminal state', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('socket closed'))
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ...activeRaw,
        status: 'cancelled',
        ended_at: OBSERVED_AT.getTime() / 1_000,
      })
    const adapter = createRazorpaySubscriptionCancellationAdapter({
      providerMode: 'test',
      sdk: { subscriptions: { fetch, cancel } },
    })

    await expect(
      adapter.cancelSubscriptionImmediately(REMOTE_SUBSCRIPTION_ID),
    ).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
