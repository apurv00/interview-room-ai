import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  DisputeEffectInput,
  FutureSubscriptionAuthorizationEffectInput,
  RefundEffectInput,
  SubscriptionChargedEffectInput,
  SubscriptionUpfrontEffectInput,
  WebhookDomainDispatchDependencies,
} from '@payments/services/webhookDomainDispatchService'
import type {
  PaymentWebhookHandler,
} from '@payments/services/webhookProcessingService'
import {
  createPaymentWebhookLaunchHandler,
  PaymentWebhookLaunchCompositionError,
} from '../paymentWebhookLaunchComposition'

function captureComposition(
  overrides: Record<string, unknown> = {},
) {
  const handler = vi.fn() as PaymentWebhookHandler
  const createDomainHandler = vi.fn(() => handler)
  const persistCapturedCheckout = vi.fn().mockResolvedValue({
    intentId: new mongoose.Types.ObjectId().toHexString(),
    providerMode: 'test',
    razorpayPaymentId: 'pay_TestPayment123',
    checkoutKind: 'order',
    fulfillmentKind: 'single_interview',
    intentStatus: 'payment_captured',
    fulfillmentId: new mongoose.Types.ObjectId().toHexString(),
    fulfillmentStatus: 'verified',
    reused: false,
  })
  const recoverChargeFulfillment = vi.fn().mockResolvedValue({
    outcome: 'one_time_entitlement_processed',
    entitlement: {
      fulfillmentStatus: 'entitlement_applied',
      reused: false,
    },
  })
  const fulfillSubscriptionCycle = vi.fn().mockResolvedValue({
    projectionDisposition: 'projected',
  })
  const fulfillSubscriptionUpfrontCycle = vi.fn().mockResolvedValue({
    projectionDisposition: 'projected',
  })
  const persistPaymentState = vi.fn().mockResolvedValue({
    outcome: 'handled',
    operationKey: 'payment-state-operation',
  })
  const persistSubscriptionState = vi.fn().mockResolvedValue({
    outcome: 'handled',
    operationKey: 'subscription-state-operation',
  })
  const observeFutureSubscriptionAuthorization =
    vi.fn().mockResolvedValue({
      intentId: '',
      planChangeRequestId: '',
      status: 'scheduled',
      reused: false,
    })
  const persistRefundWebhookEffect = vi.fn().mockResolvedValue({
    outcome: 'handled',
    operationKey: 'test:refund:rfnd_TestRefund123:event_test',
  })
  const persistDisputeWebhookEffect = vi.fn().mockResolvedValue({
    outcome: 'handled',
    operationKey: 'test:dispute:disp_TestDispute123:event_test',
  })

  const created = createPaymentWebhookLaunchHandler({
    createDomainHandler,
    persistCapturedCheckout,
    recoverChargeFulfillment,
    fulfillSubscriptionCycle,
    fulfillSubscriptionUpfrontCycle,
    persistPaymentState,
    persistSubscriptionState,
    observeFutureSubscriptionAuthorization,
    persistRefundWebhookEffect,
    persistDisputeWebhookEffect,
    ...overrides,
  })
  const domain = createDomainHandler.mock.calls[0]?.[0] as
    WebhookDomainDispatchDependencies
  return {
    created,
    handler,
    domain,
    persistCapturedCheckout,
    recoverChargeFulfillment,
    fulfillSubscriptionCycle,
    fulfillSubscriptionUpfrontCycle,
    persistPaymentState,
    persistSubscriptionState,
    observeFutureSubscriptionAuthorization,
    persistRefundWebhookEffect,
    persistDisputeWebhookEffect,
  }
}

describe('launch webhook composition', () => {
  it('recovers a captured one-time entitlement before acknowledging it', async () => {
    const composed = captureComposition()

    const result = await composed.domain.persistOneTimeCapture?.(
      {} as never,
    )

    expect(composed.created).toBe(composed.handler)
    expect(composed.persistCapturedCheckout).toHaveBeenCalledOnce()
    expect(composed.recoverChargeFulfillment).toHaveBeenCalledWith({
      fulfillmentId: expect.stringMatching(/^[a-f0-9]{24}$/),
      providerMode: 'test',
    })
    expect(result).toEqual(expect.objectContaining({
      intentStatus: 'fulfilled',
      fulfillmentStatus: 'entitlement_applied',
    }))
  })

  it('does not replay recovery after the one-time intent is fulfilled', async () => {
    const persistCapturedCheckout = vi.fn().mockResolvedValue({
      intentId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      razorpayPaymentId: 'pay_TestPayment123',
      checkoutKind: 'order',
      fulfillmentKind: 'single_interview',
      intentStatus: 'fulfilled',
      fulfillmentId: new mongoose.Types.ObjectId().toHexString(),
      fulfillmentStatus: 'entitlement_applied',
      reused: true,
    })
    const composed = captureComposition({ persistCapturedCheckout })

    const result = await composed.domain.persistOneTimeCapture?.(
      {} as never,
    )

    expect(result?.intentStatus).toBe('fulfilled')
    expect(composed.recoverChargeFulfillment).not.toHaveBeenCalled()
  })

  it('fails the webhook claim when one-time entitlement recovery defers', async () => {
    const recoverChargeFulfillment = vi.fn().mockResolvedValue({
      outcome: 'financial_policy_required',
    })
    const composed = captureComposition({ recoverChargeFulfillment })

    await expect(
      composed.domain.persistOneTimeCapture?.({} as never),
    ).rejects.toBeInstanceOf(PaymentWebhookLaunchCompositionError)
  })

  it('maps subscription.charged to paid-cycle fulfillment', async () => {
    const composed = captureComposition()
    const effect = {
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'subscription.charged',
      razorpaySubscriptionId: 'sub_TestSubscription123',
      razorpayPaymentId: 'pay_TestPayment123',
      razorpayInvoiceId: 'inv_TestInvoice123',
      razorpayOrderId: 'order_TestOrder123',
      payment: { id: 'pay_TestPayment123' },
      invoice: { id: 'inv_TestInvoice123' },
      subscription: { id: 'sub_TestSubscription123' },
      localContext: {},
    } as unknown as SubscriptionChargedEffectInput

    const acknowledgement = await composed.domain.effects
      ?.handleSubscriptionCharged?.(effect)

    expect(composed.fulfillSubscriptionCycle).toHaveBeenCalledWith({
      providerMode: 'test',
      references: {
        inboxEventId: effect.inboxEventId,
        providerMode: 'test',
        kind: 'subscription',
        eventType: 'subscription.charged',
        razorpaySubscriptionId: effect.razorpaySubscriptionId,
        razorpayPaymentId: effect.razorpayPaymentId,
        razorpayInvoiceId: effect.razorpayInvoiceId,
        razorpayOrderId: effect.razorpayOrderId,
      },
      payment: effect.payment,
      invoice: effect.invoice,
      subscription: effect.subscription,
    })
    expect(acknowledgement).toEqual({
      outcome: 'handled',
      operationKey: 'test:pay_TestPayment123:entitlement',
    })
  })

  it('maps a captured coupon upfront payment to upfront fulfillment', async () => {
    const composed = captureComposition()
    const effect = {
      inboxEventId: new mongoose.Types.ObjectId().toHexString(),
      providerMode: 'test',
      eventType: 'payment.captured',
      razorpaySubscriptionId: 'sub_TestSubscription123',
      razorpayPaymentId: 'pay_TestPayment123',
      razorpayInvoiceId: 'inv_TestInvoice123',
      razorpayOrderId: 'order_TestOrder123',
      payment: { id: 'pay_TestPayment123' },
      invoice: { id: 'inv_TestInvoice123' },
      subscription: { id: 'sub_TestSubscription123' },
      localContext: {},
    } as unknown as SubscriptionUpfrontEffectInput

    const acknowledgement = await composed.domain.effects
      ?.handleSubscriptionUpfront?.(effect)

    expect(composed.fulfillSubscriptionUpfrontCycle).toHaveBeenCalledWith({
      providerMode: 'test',
      references: {
        inboxEventId: effect.inboxEventId,
        providerMode: 'test',
        kind: 'payment',
        eventType: 'payment.captured',
        razorpaySubscriptionId: effect.razorpaySubscriptionId,
        razorpayPaymentId: effect.razorpayPaymentId,
        razorpayInvoiceId: effect.razorpayInvoiceId,
        razorpayOrderId: effect.razorpayOrderId,
      },
      payment: effect.payment,
      invoice: effect.invoice,
      subscription: effect.subscription,
    })
    expect(acknowledgement).toEqual({
      outcome: 'handled',
      operationKey: 'test:pay_TestPayment123:entitlement',
    })
  })

  it('registers durable refund and dispute effects', async () => {
    const composed = captureComposition()
    const refund = {
      providerMode: 'test',
      eventType: 'refund.processed',
      razorpayRefundId: 'rfnd_TestRefund123',
    } as unknown as RefundEffectInput
    const dispute = {
      providerMode: 'test',
      eventType: 'payment.dispute.created',
      razorpayDisputeId: 'disp_TestDispute123',
    } as unknown as DisputeEffectInput

    await expect(
      composed.domain.effects?.handleRefund?.(refund),
    ).resolves.toEqual({
      outcome: 'handled',
      operationKey: 'test:refund:rfnd_TestRefund123:event_test',
    })
    await expect(
      composed.domain.effects?.handleDispute?.(dispute),
    ).resolves.toEqual({
      outcome: 'handled',
      operationKey: 'test:dispute:disp_TestDispute123:event_test',
    })
    expect(composed.persistRefundWebhookEffect).toHaveBeenCalledWith(refund)
    expect(composed.persistDisputeWebhookEffect).toHaveBeenCalledWith(dispute)
  })

  it('delegates payment and subscription state to durable stores', async () => {
    const composed = captureComposition()
    const paymentInput = { eventType: 'payment.failed' } as never
    const subscriptionInput = {
      eventType: 'subscription.halted',
    } as never

    await composed.domain.effects?.handlePaymentState?.(paymentInput)
    await composed.domain.effects?.handleSubscriptionState?.(
      subscriptionInput,
    )

    expect(composed.persistPaymentState).toHaveBeenCalledWith(paymentInput)
    expect(composed.persistSubscriptionState).toHaveBeenCalledWith(
      subscriptionInput,
    )
  })

  it('uses exact local identity for future subscription authorization', async () => {
    const composed = captureComposition()
    const intentId = new mongoose.Types.ObjectId()
    const planChangeRequestId = new mongoose.Types.ObjectId()
    composed.observeFutureSubscriptionAuthorization.mockResolvedValue({
      intentId: intentId.toHexString(),
      planChangeRequestId: planChangeRequestId.toHexString(),
      status: 'scheduled',
      reused: false,
    })
    const input = {
      providerMode: 'test',
      razorpayPaymentId: 'pay_TestPayment123',
      payment: { id: 'pay_TestPayment123' },
      target: {
        subscription: { id: 'sub_TestSubscription123' },
        context: {
          checkout: {
            _id: intentId,
            userId: new mongoose.Types.ObjectId(),
            purpose: 'replacement',
            planChangeRequestId,
          },
        },
      },
    } as unknown as FutureSubscriptionAuthorizationEffectInput

    const acknowledgement = await composed.domain.effects
      ?.handleFutureSubscriptionAuthorization?.(input)

    expect(
      composed.observeFutureSubscriptionAuthorization,
    ).toHaveBeenCalledWith({
      userId: input.target.context.checkout?.userId.toHexString(),
      intentId: intentId.toHexString(),
      razorpayPaymentId: input.razorpayPaymentId,
      payment: input.payment,
      subscription: input.target.subscription,
    })
    expect(acknowledgement).toEqual({
      outcome: 'handled',
      operationKey:
        'future-authorization:test:pay_TestPayment123',
    })
  })
})
