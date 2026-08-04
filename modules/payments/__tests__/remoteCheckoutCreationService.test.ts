import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import {
  CURRENT_PAYMENT_CODE_READINESS,
} from '../services/paymentRuntimeGate'
import {
  createOrReuseRemoteCheckout,
  type RemoteCheckoutCreationStore,
  type TrustedRemoteCheckoutIntent,
} from '../services/remoteCheckoutCreationService'
import type {
  RazorpayOrderDto,
  RazorpayServerAdapter,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import {
  RazorpayReconciliationConflictError,
} from '../providers/razorpayServerAdapter'
import type {
  RazorpayClientFactory,
} from '../providers/razorpayClientFactory'

const userId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')
const intentId = new mongoose.Types.ObjectId('507f191e810c19729de860ea')
const now = new Date('2026-07-24T10:00:00.000Z')

function orderIntent(
  overrides: Partial<TrustedRemoteCheckoutIntent> = {},
): TrustedRemoteCheckoutIntent {
  return {
    _id: intentId,
    userId,
    kind: 'single_interview',
    providerMode: 'test',
    status: 'created',
    catalogVersion: 'consumer-inr-v1',
    receipt: 'ipr_t_507f191e810c19729de860ea',
    payablePaise: 6_900,
    discountPaise: 0,
    currency: 'INR',
    createdAt: new Date('2026-07-24T09:55:00.000Z'),
    ...overrides,
  }
}

function subscriptionIntent(
  overrides: Partial<TrustedRemoteCheckoutIntent> = {},
): TrustedRemoteCheckoutIntent {
  return {
    _id: intentId,
    userId,
    kind: 'subscription',
    providerMode: 'test',
    status: 'created',
    purpose: 'acquisition',
    leaseLane: 'a',
    authorizationExpiresAt:
      new Date('2026-07-25T09:55:00.000Z'),
    planKey: 'plus',
    catalogVersion: 'consumer-inr-v1',
    receipt: 'ipr_t_507f191e810c19729de860ea',
    payablePaise: 49_900,
    discountPaise: 10_000,
    discountedBillingCycles: 1,
    currency: 'INR',
    createdAt: new Date('2026-07-24T09:55:00.000Z'),
    ...overrides,
  }
}

function orderDto(
  overrides: Partial<RazorpayOrderDto> = {},
): RazorpayOrderDto {
  return {
    providerMode: 'test',
    id: 'order_0001',
    amountPaise: 6_900 as RazorpayOrderDto['amountPaise'],
    amountPaidPaise: 0 as RazorpayOrderDto['amountPaidPaise'],
    amountDuePaise: 6_900 as RazorpayOrderDto['amountDuePaise'],
    currency: 'INR',
    receipt: 'ipr_t_507f191e810c19729de860ea',
    status: 'created',
    attempts: 0,
    notes: {},
    createdAtEpochSeconds: 1_721_779_200,
    ...overrides,
  }
}

function subscriptionDto(
  overrides: Partial<RazorpaySubscriptionDto> = {},
): RazorpaySubscriptionDto {
  return {
    providerMode: 'test',
    id: 'sub_0001',
    planId: 'plan_PLUS0001',
    offerId: 'offer_0001',
    status: 'created',
    totalCount: 12,
    paidCount: 0,
    remainingCount: 12,
    authorizationExpiresAtEpochSeconds: 1_784_973_300,
    notes: {
      checkout_receipt: 'ipr_t_507f191e810c19729de860ea',
      checkout_intent_id: intentId.toString(),
      catalog_version: 'consumer-inr-v1',
      checkout_purpose: 'acquisition',
      subscription_lease_lane: 'a',
    },
    createdAtEpochSeconds: 1_721_779_200,
    ...overrides,
  }
}

function recordingStore(intent: TrustedRemoteCheckoutIntent | null) {
  const loadIntentForUser = vi.fn(async () => intent)
  const attachRemoteId = vi.fn(async ({ remoteId }) => ({
    outcome: 'attached' as const,
    remoteId,
  }))
  const markReview = vi.fn(async () => undefined)
  const store: RemoteCheckoutCreationStore = {
    loadIntentForUser,
    attachRemoteId,
    markReview,
  }
  return { store, loadIntentForUser, attachRemoteId, markReview }
}

function fakeAdapter(input: {
  orderRecovery?: RazorpayOrderDto | null
  createdOrder?: RazorpayOrderDto
  subscriptionRecovery?: RazorpaySubscriptionDto | null
  createdSubscription?: RazorpaySubscriptionDto
} = {}) {
  const findOrderByReceipt = vi.fn(async () => input.orderRecovery ?? null)
  const createOrder = vi.fn(async () => input.createdOrder ?? orderDto())
  const fetchOrder = vi.fn(async () => input.createdOrder ?? orderDto())
  const findSubscriptionByCheckoutReceipt = vi.fn(
    async () => input.subscriptionRecovery ?? null,
  )
  const createSubscription = vi.fn(
    async () => input.createdSubscription ?? subscriptionDto(),
  )
  const fetchSubscription = vi.fn(
    async () => input.createdSubscription ?? subscriptionDto(),
  )
  const adapter = {
    providerMode: 'test',
    findOrderByReceipt,
    createOrder,
    fetchOrder,
    findSubscriptionByCheckoutReceipt,
    createSubscription,
    fetchSubscription,
  } as unknown as RazorpayServerAdapter
  const forMode = vi.fn(() => adapter)
  const clientFactory: RazorpayClientFactory = { forMode }
  return {
    adapter,
    clientFactory,
    forMode,
    findOrderByReceipt,
    createOrder,
    fetchOrder,
    findSubscriptionByCheckoutReceipt,
    createSubscription,
    fetchSubscription,
  }
}

function allowedGate() {
  return {
    allowed: true as const,
    providerMode: 'test' as const,
    rollout: 'qa' as const,
  }
}

function baseDependencies(input: {
  intent?: TrustedRemoteCheckoutIntent | null
  adapter?: ReturnType<typeof fakeAdapter>
} = {}) {
  const store = recordingStore(
    input.intent === undefined ? orderIntent() : input.intent,
  )
  const adapter = input.adapter ?? fakeAdapter()
  return {
    ...store,
    ...adapter,
    dependencies: {
      store: store.store,
      clientFactory: adapter.clientFactory,
      evaluateSaleGate: vi.fn(async () => allowedGate()),
      now: () => new Date(now),
    },
  }
}

function requestInput() {
  return {
    userId: userId.toString(),
    intentId: intentId.toString(),
  }
}

describe('remote checkout creation orchestration', () => {
  it('keeps Live readiness false and makes zero calls when an explicit gate blocks sale', async () => {
    expect(CURRENT_PAYMENT_CODE_READINESS).toEqual({
      remoteCreationReady: true,
      recoveryReady: true,
      liveCreationReady: false,
    })
    const harness = baseDependencies()
    const evaluateSaleGate = vi.fn(async () => ({
      allowed: false as const,
      reason: 'remote_creation_not_ready' as const,
    }))

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      evaluateSaleGate,
    })).rejects.toMatchObject({
      code: 'sale_blocked',
      saleBlockReason: 'remote_creation_not_ready',
    })
    expect(harness.loadIntentForUser).not.toHaveBeenCalled()
    expect(harness.forMode).not.toHaveBeenCalled()
    expect(harness.findOrderByReceipt).not.toHaveBeenCalled()
    expect(harness.createOrder).not.toHaveBeenCalled()
  })

  it('is inert when the explicit Live sale decision is dark', async () => {
    const harness = baseDependencies()
    const evaluateSaleGate = vi.fn(async () => ({
      allowed: false as const,
      reason: 'live_creation_not_ready' as const,
    }))

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      evaluateSaleGate,
    })).rejects.toMatchObject({
      code: 'sale_blocked',
      saleBlockReason: 'live_creation_not_ready',
    })
    expect(harness.loadIntentForUser).not.toHaveBeenCalled()
    expect(harness.forMode).not.toHaveBeenCalled()
  })

  it('loads only the authenticated user intent and rejects mode confusion', async () => {
    const harness = baseDependencies({
      intent: orderIntent({ providerMode: 'live' }),
    })
    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({ code: 'intent_mode_mismatch' })
    expect(harness.loadIntentForUser).toHaveBeenCalledWith({
      intentId,
      userId,
    })
    expect(harness.forMode).not.toHaveBeenCalled()
  })

  it('rejects every intent state except created and remote_created', async () => {
    const harness = baseDependencies({
      intent: orderIntent({ status: 'payment_captured' }),
    })
    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({ code: 'intent_state_invalid' })
    expect(harness.forMode).not.toHaveBeenCalled()
  })

  it('recovers before create and attaches a validated exact Order', async () => {
    const adapter = fakeAdapter({ orderRecovery: orderDto() })
    const harness = baseDependencies({ adapter })
    const result = await createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )

    expect(result).toMatchObject({
      remoteId: 'order_0001',
      source: 'pre_create_recovery',
      reused: true,
    })
    expect(harness.findOrderByReceipt).toHaveBeenCalledWith(
      'ipr_t_507f191e810c19729de860ea',
    )
    expect(harness.createOrder).not.toHaveBeenCalled()
    expect(harness.attachRemoteId).toHaveBeenCalledWith({
      intent: orderIntent(),
      remoteId: 'order_0001',
    })
  })

  it('creates a server-priced Order only after zero recovery and attaches it', async () => {
    const harness = baseDependencies()
    const result = await createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )

    expect(result).toMatchObject({
      remoteId: 'order_0001',
      source: 'created',
      reused: false,
    })
    expect(harness.createOrder).toHaveBeenCalledWith({
      amountPaise: 6_900,
      currency: 'INR',
      receipt: 'ipr_t_507f191e810c19729de860ea',
      notes: {
        checkout_intent_id: intentId.toString(),
        catalog_version: 'consumer-inr-v1',
      },
    })
  })

  it('fetches and validates an existing local remote id without recovery or create', async () => {
    const intent = orderIntent({
      status: 'remote_created',
      razorpayOrderId: 'order_0001',
    })
    const harness = baseDependencies({ intent })
    const result = await createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )

    expect(result).toMatchObject({
      source: 'existing',
      reused: true,
    })
    expect(harness.fetchOrder).toHaveBeenCalledWith('order_0001')
    expect(harness.findOrderByReceipt).not.toHaveBeenCalled()
    expect(harness.createOrder).not.toHaveBeenCalled()
  })

  it('reviews an existing local id when fetch returns a different remote entity', async () => {
    const intent = orderIntent({
      status: 'remote_created',
      razorpayOrderId: 'order_0001',
    })
    const adapter = fakeAdapter({
      createdOrder: orderDto({ id: 'order_0002' }),
    })
    const harness = baseDependencies({ intent, adapter })

    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({ code: 'remote_mismatch' })
    expect(harness.markReview).toHaveBeenCalledTimes(1)
    expect(harness.findOrderByReceipt).not.toHaveBeenCalled()
    expect(harness.createOrder).not.toHaveBeenCalled()
  })

  it('recovers after an ambiguous Order create failure', async () => {
    const adapter = fakeAdapter()
    adapter.createOrder.mockRejectedValueOnce(new Error('socket closed'))
    adapter.findOrderByReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(orderDto())
    const harness = baseDependencies({ adapter })

    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).resolves.toMatchObject({
      remoteId: 'order_0001',
      source: 'post_failure_recovery',
      reused: true,
    })
    expect(harness.findOrderByReceipt).toHaveBeenCalledTimes(2)
  })

  it('reviews an unresolved ambiguous create instead of attempting another remote create', async () => {
    const adapter = fakeAdapter()
    adapter.createOrder.mockRejectedValueOnce(new Error('socket closed'))
    const harness = baseDependencies({ adapter })

    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(harness.findOrderByReceipt).toHaveBeenCalledTimes(2)
    expect(harness.createOrder).toHaveBeenCalledTimes(1)
    expect(harness.markReview).toHaveBeenCalledTimes(1)
  })

  it('moves mismatched or ambiguous recovery outcomes to explicit review', async () => {
    const mismatched = fakeAdapter({
      orderRecovery: orderDto({ amountPaise: 6_899 as never }),
    })
    const mismatchHarness = baseDependencies({ adapter: mismatched })
    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      mismatchHarness.dependencies,
    )).rejects.toMatchObject({ code: 'remote_mismatch' })
    expect(mismatchHarness.markReview).toHaveBeenCalledTimes(1)
    expect(mismatchHarness.createOrder).not.toHaveBeenCalled()

    const conflict = fakeAdapter()
    conflict.findOrderByReceipt.mockRejectedValueOnce(
      new RazorpayReconciliationConflictError('order'),
    )
    const conflictHarness = baseDependencies({ adapter: conflict })
    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      conflictHarness.dependencies,
    )).rejects.toMatchObject({ code: 'reconciliation_conflict' })
    expect(conflictHarness.markReview).toHaveBeenCalledTimes(1)
    expect(conflictHarness.createOrder).not.toHaveBeenCalled()
  })

  it('marks an attach race conflict for review instead of replacing its remote id', async () => {
    const harness = baseDependencies()
    harness.attachRemoteId.mockResolvedValueOnce({ outcome: 'conflict' })

    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({ code: 'persistence_conflict' })
    expect(harness.markReview).toHaveBeenCalledTimes(1)
  })

  it('allows only one of two different concurrent remote ids to win the attach CAS', async () => {
    const intent = orderIntent()
    let attachedRemoteId: string | undefined
    const markReview = vi.fn(async () => undefined)
    const store: RemoteCheckoutCreationStore = {
      async loadIntentForUser() {
        return intent
      },
      async attachRemoteId({ remoteId }) {
        await Promise.resolve()
        if (attachedRemoteId === undefined) {
          attachedRemoteId = remoteId
          return { outcome: 'attached', remoteId }
        }
        if (attachedRemoteId === remoteId) {
          return { outcome: 'reused', remoteId }
        }
        return { outcome: 'conflict' }
      },
      markReview,
    }
    const adapter = fakeAdapter()
    adapter.createOrder
      .mockResolvedValueOnce(orderDto({ id: 'order_0001' }))
      .mockResolvedValueOnce(orderDto({ id: 'order_0002' }))
    const sharedDependencies = {
      store,
      clientFactory: adapter.clientFactory,
      evaluateSaleGate: async () => allowedGate(),
      now: () => new Date(now),
    }

    const results = await Promise.allSettled([
      createOrReuseRemoteCheckout(requestInput(), sharedDependencies),
      createOrReuseRemoteCheckout(requestInput(), sharedDependencies),
    ])
    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'persistence_conflict' }),
    })
    expect(markReview).toHaveBeenCalledTimes(1)
  })

  it('uses only the trusted subscription Plan/Offer and keeps customer notifications off', async () => {
    const intent = subscriptionIntent()
    const harness = baseDependencies({ intent })
    const resolveSubscriptionSpec = vi.fn(async () => ({
      planKey: 'plus' as const,
      razorpayPlanId: 'plan_PLUS0001',
      razorpayOfferId: 'offer_0001',
      totalCount: 12,
      purpose: 'acquisition' as const,
      leaseLane: 'a' as const,
      authorizationExpiresAtEpochSeconds: 1_784_973_300,
    }))

    const result = await createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      resolveSubscriptionSpec,
    })

    expect(result).toMatchObject({
      kind: 'subscription',
      remoteId: 'sub_0001',
      source: 'created',
    })
    expect(resolveSubscriptionSpec).toHaveBeenCalledWith(intent)
    expect(harness.findSubscriptionByCheckoutReceipt)
      .toHaveBeenCalledWith({
        checkoutReceipt: intent.receipt,
        expectedPlanId: 'plan_PLUS0001',
        fromEpochSeconds: 1_784_886_600,
        toEpochSeconds: 1_784_887_500,
      })
    expect(harness.createSubscription).toHaveBeenCalledWith({
      planId: 'plan_PLUS0001',
      totalCount: 12,
      offerId: 'offer_0001',
      authorizationExpiresAtEpochSeconds: 1_784_973_300,
      customerNotify: false,
      receipt: intent.receipt,
      notes: {
        checkout_intent_id: intentId.toString(),
        catalog_version: 'consumer-inr-v1',
        checkout_purpose: 'acquisition',
        subscription_lease_lane: 'a',
      },
    })
    expect(harness.attachRemoteId).toHaveBeenCalledWith({
      intent,
      remoteId: 'sub_0001',
    })
  })

  it('rejects missing/incorrect trusted subscription specs before provider access', async () => {
    const intent = subscriptionIntent()
    const harness = baseDependencies({ intent })

    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      harness.dependencies,
    )).rejects.toMatchObject({
      code: 'subscription_spec_unavailable',
    })
    expect(harness.forMode).not.toHaveBeenCalled()

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      resolveSubscriptionSpec: async () => ({
        planKey: 'plus',
        razorpayPlanId: 'plan_PLUS0001',
        totalCount: 12,
        purpose: 'acquisition',
        leaseLane: 'a',
        authorizationExpiresAtEpochSeconds: 1_784_973_300,
      }),
    })).rejects.toMatchObject({
      code: 'subscription_spec_unavailable',
    })
    expect(harness.createSubscription).not.toHaveBeenCalled()
  })

  it('rejects a Subscription response with wrong Plan, Offer, or receipt note', async () => {
    const intent = subscriptionIntent()
    const adapter = fakeAdapter({
      subscriptionRecovery: subscriptionDto({
        notes: { checkout_receipt: 'wrong_receipt' },
      }),
    })
    const harness = baseDependencies({ intent, adapter })

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      resolveSubscriptionSpec: async () => ({
        planKey: 'plus',
        razorpayPlanId: 'plan_PLUS0001',
        razorpayOfferId: 'offer_0001',
        totalCount: 12,
        purpose: 'acquisition',
        leaseLane: 'a',
        authorizationExpiresAtEpochSeconds: 1_784_973_300,
      }),
    })).rejects.toMatchObject({ code: 'remote_mismatch' })
    expect(harness.markReview).toHaveBeenCalledTimes(1)
    expect(harness.createSubscription).not.toHaveBeenCalled()
  })

  it('fails closed for legacy or expired local subscription contracts', async () => {
    const legacy = subscriptionIntent({
      purpose: undefined,
      leaseLane: undefined,
      authorizationExpiresAt: undefined,
    })
    const legacyHarness = baseDependencies({ intent: legacy })
    await expect(createOrReuseRemoteCheckout(
      requestInput(),
      legacyHarness.dependencies,
    )).rejects.toMatchObject({ code: 'intent_shape_invalid' })
    expect(legacyHarness.forMode).not.toHaveBeenCalled()

    const expired = subscriptionIntent({
      authorizationExpiresAt: new Date(now),
    })
    const expiredHarness = baseDependencies({ intent: expired })
    const crossingDeadline = vi.fn()
      .mockReturnValueOnce(
        new Date('2026-07-24T09:59:59.000Z'),
      )
      .mockReturnValueOnce(new Date(now))
    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...expiredHarness.dependencies,
      now: crossingDeadline,
      resolveSubscriptionSpec: async () => ({
        planKey: 'plus',
        razorpayPlanId: 'plan_PLUS0001',
        razorpayOfferId: 'offer_0001',
        totalCount: 12,
        purpose: 'acquisition',
        leaseLane: 'a',
        authorizationExpiresAtEpochSeconds:
          Math.floor(now.getTime() / 1_000),
      }),
    })).rejects.toMatchObject({ code: 'intent_state_invalid' })
    expect(expiredHarness.findSubscriptionByCheckoutReceipt)
      .toHaveBeenCalledTimes(1)
    expect(expiredHarness.createSubscription).not.toHaveBeenCalled()
    expect(crossingDeadline).toHaveBeenCalledTimes(2)
  })

  it('pins future start, expiry, and plan-change lineage exactly', async () => {
    const planChangeRequestId =
      new mongoose.Types.ObjectId('507f1f77bcf86cd799439012')
    const intent = subscriptionIntent({
      purpose: 'replacement',
      planChangeRequestId,
      leaseLane: 'b',
      requestedStartAt: new Date('2026-07-26T10:00:00.000Z'),
      authorizationExpiresAt:
        new Date('2026-07-25T10:00:00.000Z'),
    })
    const created = subscriptionDto({
      startAtEpochSeconds: 1_785_060_000,
      authorizationExpiresAtEpochSeconds: 1_784_973_600,
      notes: {
        checkout_receipt: intent.receipt,
        checkout_intent_id: intentId.toString(),
        catalog_version: 'consumer-inr-v1',
        checkout_purpose: 'replacement',
        subscription_lease_lane: 'b',
        plan_change_request_id: planChangeRequestId.toString(),
      },
    })
    const adapter = fakeAdapter({ createdSubscription: created })
    const harness = baseDependencies({ intent, adapter })
    const spec = {
      planKey: 'plus' as const,
      razorpayPlanId: 'plan_PLUS0001',
      razorpayOfferId: 'offer_0001',
      totalCount: 12,
      purpose: 'replacement' as const,
      planChangeRequestId: planChangeRequestId.toString(),
      leaseLane: 'b' as const,
      startAtEpochSeconds: 1_785_060_000,
      authorizationExpiresAtEpochSeconds: 1_784_973_600,
    }

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      resolveSubscriptionSpec: async () => spec,
    })).resolves.toMatchObject({ source: 'created' })
    expect(harness.createSubscription).toHaveBeenCalledWith({
      planId: 'plan_PLUS0001',
      totalCount: 12,
      offerId: 'offer_0001',
      startAtEpochSeconds: 1_785_060_000,
      authorizationExpiresAtEpochSeconds: 1_784_973_600,
      customerNotify: false,
      receipt: intent.receipt,
      notes: {
        checkout_intent_id: intentId.toString(),
        catalog_version: 'consumer-inr-v1',
        checkout_purpose: 'replacement',
        subscription_lease_lane: 'b',
        plan_change_request_id: planChangeRequestId.toString(),
      },
    })

    const mismatchedAdapter = fakeAdapter({
      subscriptionRecovery: subscriptionDto({
        startAtEpochSeconds: 1_785_060_001,
        authorizationExpiresAtEpochSeconds: 1_784_973_600,
        notes: created.notes,
      }),
    })
    const mismatchHarness = baseDependencies({
      intent,
      adapter: mismatchedAdapter,
    })
    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...mismatchHarness.dependencies,
      resolveSubscriptionSpec: async () => spec,
    })).rejects.toMatchObject({ code: 'remote_mismatch' })
    expect(mismatchHarness.markReview).toHaveBeenCalledTimes(1)
    expect(mismatchHarness.createSubscription).not.toHaveBeenCalled()
  })

  it('reviews a recovered subscription that omits the bounded expiry', async () => {
    const intent = subscriptionIntent()
    const adapter = fakeAdapter({
      subscriptionRecovery: subscriptionDto({
        authorizationExpiresAtEpochSeconds: undefined,
      }),
    })
    const harness = baseDependencies({ intent, adapter })

    await expect(createOrReuseRemoteCheckout(requestInput(), {
      ...harness.dependencies,
      resolveSubscriptionSpec: async () => ({
        planKey: 'plus',
        razorpayPlanId: 'plan_PLUS0001',
        razorpayOfferId: 'offer_0001',
        totalCount: 12,
        purpose: 'acquisition',
        leaseLane: 'a',
        authorizationExpiresAtEpochSeconds: 1_784_973_300,
      }),
    })).rejects.toMatchObject({ code: 'remote_mismatch' })
    expect(harness.markReview).toHaveBeenCalledTimes(1)
    expect(harness.createSubscription).not.toHaveBeenCalled()
  })
})
