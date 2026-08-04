import {
  persistCapturedCheckoutWithCommercialAnalytics,
  persistPaymentStateWithCommercialAnalytics,
} from './paymentCommercialAnalyticsComposition'
import {
  fulfillSubscriptionCycleWithCommercialAnalytics,
  recoverChargeFulfillmentWithCommercialAnalytics,
} from './entitlementCommercialAnalyticsComposition'
import {
  observeFutureSubscriptionAuthorization,
} from '@payments/services/subscriptionLifecycleService'
import {
  persistSubscriptionState,
} from '@payments/services/subscriptionStatePersistenceService'
import {
  createRazorpayWebhookDomainHandler,
  type FutureSubscriptionAuthorizationEffectInput,
  type PersistOneTimeWebhookCapture,
  type SubscriptionChargedEffectInput,
  type WebhookDomainDispatchDependencies,
  type WebhookDomainEffectHandlers,
} from '@payments/services/webhookDomainDispatchService'
import type {
  PaymentWebhookHandler,
} from '@payments/services/webhookProcessingService'

type PersistCapturedCheckout =
  typeof persistCapturedCheckoutWithCommercialAnalytics
type RecoverChargeFulfillment =
  typeof recoverChargeFulfillmentWithCommercialAnalytics
type FulfillSubscriptionCycle =
  typeof fulfillSubscriptionCycleWithCommercialAnalytics
type PersistPaymentState =
  typeof persistPaymentStateWithCommercialAnalytics
type PersistSubscriptionState = typeof persistSubscriptionState
type ObserveFutureSubscriptionAuthorization =
  typeof observeFutureSubscriptionAuthorization

export interface PaymentWebhookLaunchCompositionDependencies {
  createDomainHandler?: typeof createRazorpayWebhookDomainHandler
  persistCapturedCheckout?: PersistCapturedCheckout
  recoverChargeFulfillment?: RecoverChargeFulfillment
  fulfillSubscriptionCycle?: FulfillSubscriptionCycle
  persistPaymentState?: PersistPaymentState
  persistSubscriptionState?: PersistSubscriptionState
  observeFutureSubscriptionAuthorization?:
    ObserveFutureSubscriptionAuthorization
}

export class PaymentWebhookLaunchCompositionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentWebhookLaunchCompositionError'
  }
}

function subscriptionCycleInput(
  input: SubscriptionChargedEffectInput,
) {
  return {
    providerMode: input.providerMode,
    references: {
      inboxEventId: input.inboxEventId,
      providerMode: input.providerMode,
      kind: 'subscription' as const,
      eventType: 'subscription.charged' as const,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayInvoiceId: input.razorpayInvoiceId,
      ...(input.razorpayOrderId
        ? { razorpayOrderId: input.razorpayOrderId }
        : {}),
    },
    payment: input.payment,
    invoice: input.invoice,
    subscription: input.subscription,
  }
}

async function observeFutureAuthorization(
  input: FutureSubscriptionAuthorizationEffectInput,
  observe: ObserveFutureSubscriptionAuthorization,
) {
  const checkout = input.target.context.checkout
  if (
    !checkout ||
    (
      checkout.purpose !== 'replacement' &&
      checkout.purpose !== 'resubscribe'
    ) ||
    !checkout.planChangeRequestId
  ) {
    throw new PaymentWebhookLaunchCompositionError(
      'Future subscription authorization has no exact local target',
    )
  }

  const result = await observe({
    userId: checkout.userId.toHexString(),
    intentId: checkout._id.toHexString(),
    razorpayPaymentId: input.razorpayPaymentId,
    payment: input.payment,
    subscription: input.target.subscription,
  })
  if (
    result.intentId !== checkout._id.toHexString() ||
    result.planChangeRequestId !==
      checkout.planChangeRequestId.toHexString() ||
    result.status === 'authorization_pending' ||
    result.status === 'authorized' ||
    result.status === 'reconciling'
  ) {
    throw new PaymentWebhookLaunchCompositionError(
      'Future subscription authorization remains recoverable',
    )
  }
}

function oneTimeCaptureWithRecovery(input: {
  persist: PersistCapturedCheckout
  recover: RecoverChargeFulfillment
}): PersistOneTimeWebhookCapture {
  return async (captureInput) => {
    const captured = await input.persist(captureInput)
    if (
      captured.checkoutKind !== 'order' ||
      (
        captured.fulfillmentKind !== 'single_interview' &&
        captured.fulfillmentKind !== 'premium_resume'
      )
    ) {
      throw new PaymentWebhookLaunchCompositionError(
        'Captured one-time webhook has inconsistent product identity',
      )
    }
    if (captured.intentStatus === 'fulfilled') return captured
    if (captured.fulfillmentStatus !== 'verified') {
      throw new PaymentWebhookLaunchCompositionError(
        'Captured one-time webhook is not ready for entitlement recovery',
      )
    }

    const recovery = await input.recover({
      fulfillmentId: captured.fulfillmentId,
      providerMode: captured.providerMode,
    })
    if (recovery.outcome !== 'one_time_entitlement_processed') {
      throw new PaymentWebhookLaunchCompositionError(
        'Captured one-time entitlement did not complete',
      )
    }
    return {
      ...captured,
      intentStatus: 'fulfilled',
      fulfillmentStatus: recovery.entitlement.fulfillmentStatus,
      reused: captured.reused || recovery.entitlement.reused,
    }
  }
}

/**
 * Binds the durable webhook processor to the existing idempotent payment
 * services. The caller still owns inbox claiming and retryable HTTP status
 * mapping; this composition performs no work until a verified event runs.
 */
export function createPaymentWebhookLaunchHandler(
  dependencies: PaymentWebhookLaunchCompositionDependencies = {},
): PaymentWebhookHandler {
  const persistCapturedCheckout =
    dependencies.persistCapturedCheckout ??
    persistCapturedCheckoutWithCommercialAnalytics
  const recoverChargeFulfillment =
    dependencies.recoverChargeFulfillment ??
    recoverChargeFulfillmentWithCommercialAnalytics
  const fulfillSubscriptionCycle =
    dependencies.fulfillSubscriptionCycle ??
    fulfillSubscriptionCycleWithCommercialAnalytics
  const persistPaymentState =
    dependencies.persistPaymentState ??
    persistPaymentStateWithCommercialAnalytics
  const persistSubscriptionLifecycle =
    dependencies.persistSubscriptionState ??
    persistSubscriptionState
  const observeFutureAuthorizationEffect =
    dependencies.observeFutureSubscriptionAuthorization ??
    observeFutureSubscriptionAuthorization

  const effects: WebhookDomainEffectHandlers = {
    handlePaymentState: (input) => persistPaymentState(input),
    handleFutureSubscriptionAuthorization: async (input) => {
      await observeFutureAuthorization(
        input,
        observeFutureAuthorizationEffect,
      )
      return {
        outcome: 'handled',
        operationKey:
          `future-authorization:${input.providerMode}:` +
          input.razorpayPaymentId,
      }
    },
    handleSubscriptionCharged: async (input) => {
      await fulfillSubscriptionCycle(subscriptionCycleInput(input))
      return {
        outcome: 'handled',
        operationKey:
          `${input.providerMode}:` +
          `${input.razorpayPaymentId}:entitlement`,
      }
    },
    handleSubscriptionState: (input) => (
      persistSubscriptionLifecycle(input)
    ),
  }

  const domainDependencies: WebhookDomainDispatchDependencies = {
    effects,
    persistOneTimeCapture: oneTimeCaptureWithRecovery({
      persist: persistCapturedCheckout,
      recover: recoverChargeFulfillment,
    }),
  }
  const createDomainHandler =
    dependencies.createDomainHandler ??
    createRazorpayWebhookDomainHandler
  return createDomainHandler(domainDependencies)
}

export const paymentWebhookLaunchHandler =
  createPaymentWebhookLaunchHandler()
