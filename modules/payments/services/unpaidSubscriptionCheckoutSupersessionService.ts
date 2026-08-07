import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import { CheckoutIntent } from '../models/CheckoutIntent'
import {
  ConsumerSubscriptionLease,
} from '../models/ConsumerSubscriptionLease'
import { PaymentAttempt } from '../models/PaymentAttempt'
import {
  Subscription,
  type SubscriptionStatus,
} from '../models/Subscription'
import {
  createRazorpayClientFactory,
  createRazorpaySubscriptionCancellationClientFactory,
  type RazorpayClientFactory,
  type RazorpaySubscriptionCancellationClientFactory,
} from '../providers/razorpayClientFactory'
import type {
  RazorpayInvoiceDto,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import {
  assertSubscriptionCommercialIntent,
  assertSubscriptionLifecycleIntent,
  mongoSubscriptionCycleCommercialResolver,
  requireSubscriptionCommercialTerms,
  type OriginalSubscriptionCheckoutIntent,
  type SubscriptionCycleCommercialResolver,
} from './subscriptionCycleFulfillmentService'
import {
  persistSubscriptionProviderObservation,
} from './subscriptionStatePersistenceService'
import {
  mongoWebhookDomainMappingStore,
  type TrustedWebhookSubscriptionContext,
  type WebhookDomainMappingStore,
} from './webhookDomainDispatchService'

const SAFE_LOCAL_INTENT_STATUSES = [
  'remote_created',
  'checkout_opened',
  'abandoned',
  'failed',
  'cancelled',
] as const

const SAFE_LOCAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'created',
  'activation_pending',
  'cancelled',
  'expired',
]

type SupersessionErrorCode = 'provider_unavailable' | 'review_required'

export class UnpaidSubscriptionCheckoutSupersessionError extends Error {
  constructor(
    readonly code: SupersessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'UnpaidSubscriptionCheckoutSupersessionError'
  }
}

export interface BlockingSubscriptionCheckout {
  lease: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    lane: 'a'
    ownerCheckoutIntentId: mongoose.Types.ObjectId
    razorpaySubscriptionId: string
    status: 'held'
  }
  intent: OriginalSubscriptionCheckoutIntent & {
    kind: 'subscription'
    planKey: 'plus' | 'pro'
    purpose: 'acquisition'
    leaseLane: 'a'
    authorizationExpiresAt: Date
    razorpaySubscriptionId: string
    receipt: string
  }
  hasLocalPaymentEvidence: boolean
}

export interface UnpaidSubscriptionCheckoutSupersessionStore {
  loadBlockingCheckout(input: {
    userId: string
    providerMode: ProviderMode
  }): Promise<BlockingSubscriptionCheckout | null>
}

interface LeanLease {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  lane: 'a'
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId?: string
  status: 'held'
}

interface LeanCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'subscription'
  providerMode: ProviderMode
  status: OriginalSubscriptionCheckoutIntent['status']
  purpose?: OriginalSubscriptionCheckoutIntent['purpose']
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: OriginalSubscriptionCheckoutIntent['leaseLane']
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  quoteSnapshot: OriginalSubscriptionCheckoutIntent['quote']
  razorpaySubscriptionId?: string
  receipt: string
  createdAt: Date
}

interface LeanSubscriptionEvidence {
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
}

function reviewRequired(
  message: string,
  cause?: unknown,
): UnpaidSubscriptionCheckoutSupersessionError {
  return new UnpaidSubscriptionCheckoutSupersessionError(
    'review_required',
    message,
    cause === undefined ? undefined : { cause },
  )
}

function providerUnavailable(
  message: string,
  cause?: unknown,
): UnpaidSubscriptionCheckoutSupersessionError {
  return new UnpaidSubscriptionCheckoutSupersessionError(
    'provider_unavailable',
    message,
    cause === undefined ? undefined : { cause },
  )
}

function exactDate(
  left: Date | undefined,
  right: Date | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.getTime() === right.getTime()
}

function localContextMatches(
  blocking: BlockingSubscriptionCheckout,
  context: TrustedWebhookSubscriptionContext | null,
): context is TrustedWebhookSubscriptionContext & {
  checkout: NonNullable<TrustedWebhookSubscriptionContext['checkout']>
} {
  const checkout = context?.checkout
  const intent = blocking.intent
  if (
    !checkout ||
    !checkout._id.equals(intent.id) ||
    !checkout.userId.equals(intent.userId) ||
    checkout.providerMode !== intent.providerMode ||
    checkout.status !== intent.status ||
    checkout.purpose !== intent.purpose ||
    checkout.planChangeRequestId !== undefined ||
    checkout.leaseLane !== intent.leaseLane ||
    !exactDate(checkout.requestedStartAt, intent.requestedStartAt) ||
    !exactDate(
      checkout.authorizationExpiresAt,
      intent.authorizationExpiresAt,
    ) ||
    checkout.planKey !== intent.planKey ||
    checkout.catalogVersion !== intent.catalogVersion ||
    checkout.razorpaySubscriptionId !== intent.razorpaySubscriptionId ||
    checkout.receipt !== intent.receipt
  ) {
    return false
  }
  const subscription = context.subscription
  return !subscription || (
    subscription.userId.equals(intent.userId) &&
    subscription.providerMode === intent.providerMode &&
    subscription.planKey === intent.planKey &&
    subscription.catalogVersion === intent.catalogVersion &&
    subscription.razorpaySubscriptionId === intent.razorpaySubscriptionId &&
    subscription.checkoutIntentId?.equals(intent.id) === true &&
    subscription.planChangeRequestId === undefined &&
    subscription.replacesSubscriptionId === undefined &&
    subscription.leaseLane === intent.leaseLane &&
    exactDate(subscription.requestedStartAt, intent.requestedStartAt) &&
    exactDate(
      subscription.authorizationExpiresAt,
      intent.authorizationExpiresAt,
    ) &&
    SAFE_LOCAL_SUBSCRIPTION_STATUSES.includes(subscription.status)
  )
}

function subscriptionHasNoPaidPeriod(
  subscription: RazorpaySubscriptionDto,
): boolean {
  return (
    subscription.paidCount === 0 &&
    subscription.currentStartEpochSeconds === undefined &&
    subscription.currentEndEpochSeconds === undefined
  )
}

function terminalUnpaidSubscription(
  subscription: RazorpaySubscriptionDto,
): boolean {
  return (
    (
      subscription.status === 'cancelled' ||
      subscription.status === 'expired'
    ) &&
    subscriptionHasNoPaidPeriod(subscription)
  )
}

function invoiceHasPaymentEvidence(invoice: RazorpayInvoiceDto): boolean {
  return (
    invoice.amountPaidPaise > 0 ||
    invoice.partialPayment ||
    invoice.status === 'paid' ||
    invoice.status === 'partially_paid'
  )
}

async function assertNoProviderPaymentEvidence(input: {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  clientFactory: RazorpayClientFactory
}): Promise<void> {
  const client = input.clientFactory.forMode(input.providerMode)
  let invoices: RazorpayInvoiceDto[]
  try {
    invoices = await client.fetchSubscriptionInvoices(
      input.razorpaySubscriptionId,
    )
  } catch (error) {
    throw providerUnavailable(
      'Razorpay payment evidence is temporarily unavailable',
      error,
    )
  }

  for (const invoice of invoices) {
    if (
      invoice.providerMode !== input.providerMode ||
      invoice.subscriptionId !== input.razorpaySubscriptionId ||
      invoice.currency !== 'INR'
    ) {
      throw reviewRequired(
        'Razorpay invoice evidence does not match the blocked checkout',
      )
    }
    if (invoiceHasPaymentEvidence(invoice)) {
      throw reviewRequired(
        'The blocked checkout has provider payment evidence',
      )
    }
    if (!invoice.paymentId) continue

    let payment
    try {
      payment = await client.fetchPayment(invoice.paymentId)
    } catch (error) {
      throw providerUnavailable(
        'Razorpay payment evidence is temporarily unavailable',
        error,
      )
    }
    if (
      payment.providerMode !== input.providerMode ||
      payment.subscriptionId !== input.razorpaySubscriptionId ||
      payment.invoiceId !== invoice.id ||
      payment.currency !== 'INR'
    ) {
      throw reviewRequired(
        'Razorpay payment evidence does not match the blocked checkout',
      )
    }
    if (
      payment.status !== 'failed' ||
      payment.captured ||
      payment.amountRefundedPaise > 0
    ) {
      throw reviewRequired(
        'The blocked checkout has provider payment evidence',
      )
    }
  }
}

export const mongoUnpaidSubscriptionCheckoutSupersessionStore:
UnpaidSubscriptionCheckoutSupersessionStore = {
  async loadBlockingCheckout(input) {
    if (!mongoose.isValidObjectId(input.userId)) {
      throw reviewRequired('The checkout owner is invalid')
    }
    await connectDB()
    const userId = new mongoose.Types.ObjectId(input.userId)
    const lease = await ConsumerSubscriptionLease.findOne({
      userId,
      providerMode: input.providerMode,
      lane: 'a',
      status: 'held',
    }).select({
      userId: 1,
      providerMode: 1,
      lane: 1,
      ownerCheckoutIntentId: 1,
      razorpaySubscriptionId: 1,
      status: 1,
    }).lean<LeanLease>()
    if (!lease) return null

    const checkout = await CheckoutIntent.findOne({
      _id: lease.ownerCheckoutIntentId,
      userId,
      providerMode: input.providerMode,
      kind: 'subscription',
    }).select({
      _id: 1,
      userId: 1,
      kind: 1,
      providerMode: 1,
      status: 1,
      purpose: 1,
      planChangeRequestId: 1,
      leaseLane: 1,
      requestedStartAt: 1,
      authorizationExpiresAt: 1,
      planKey: 1,
      catalogVersion: 1,
      quoteSnapshot: 1,
      razorpaySubscriptionId: 1,
      receipt: 1,
      createdAt: 1,
    }).lean<LeanCheckoutIntent>()
    if (!checkout) {
      throw reviewRequired('The blocking checkout could not be correlated')
    }

    const remoteId = lease.razorpaySubscriptionId
    if (
      checkout.purpose !== 'acquisition' ||
      checkout.planChangeRequestId !== undefined ||
      checkout.leaseLane !== 'a' ||
      (checkout.planKey !== 'plus' && checkout.planKey !== 'pro') ||
      !checkout.authorizationExpiresAt ||
      !remoteId ||
      checkout.razorpaySubscriptionId !== remoteId ||
      !SAFE_LOCAL_INTENT_STATUSES.includes(
        checkout.status as (typeof SAFE_LOCAL_INTENT_STATUSES)[number],
      )
    ) {
      throw reviewRequired('The blocking checkout is not safely supersedable')
    }

    const [paymentAttempt, fulfillment, subscription] = await Promise.all([
      PaymentAttempt.exists({
        userId,
        providerMode: input.providerMode,
        checkoutIntentId: checkout._id,
        status: { $ne: 'failed' },
      }),
      ChargeFulfillment.exists({
        userId,
        providerMode: input.providerMode,
        kind: 'subscription_cycle',
        razorpaySubscriptionId: remoteId,
      }),
      Subscription.findOne({
        userId,
        providerMode: input.providerMode,
        razorpaySubscriptionId: remoteId,
      }).select({
        status: 1,
        currentPeriodKey: 1,
        currentPeriodStart: 1,
        currentPeriodEnd: 1,
      }).lean<LeanSubscriptionEvidence>(),
    ])
    const localSubscriptionUnsafe = Boolean(
      subscription && (
        !SAFE_LOCAL_SUBSCRIPTION_STATUSES.includes(subscription.status) ||
        subscription.currentPeriodKey ||
        subscription.currentPeriodStart ||
        subscription.currentPeriodEnd
      ),
    )

    return {
      lease: {
        userId: lease.userId,
        providerMode: lease.providerMode,
        lane: lease.lane,
        ownerCheckoutIntentId: lease.ownerCheckoutIntentId,
        razorpaySubscriptionId: remoteId,
        status: lease.status,
      },
      intent: {
        id: checkout._id,
        userId: checkout.userId,
        kind: checkout.kind,
        providerMode: checkout.providerMode,
        status: checkout.status,
        purpose: checkout.purpose,
        leaseLane: checkout.leaseLane,
        requestedStartAt: checkout.requestedStartAt,
        authorizationExpiresAt: checkout.authorizationExpiresAt,
        planKey: checkout.planKey,
        catalogVersion: checkout.catalogVersion,
        razorpaySubscriptionId: remoteId,
        receipt: checkout.receipt,
        createdAt: checkout.createdAt,
        quote: checkout.quoteSnapshot,
      },
      hasLocalPaymentEvidence: Boolean(
        paymentAttempt || fulfillment || localSubscriptionUnsafe,
      ),
    }
  },
}

export interface UnpaidSubscriptionCheckoutSupersessionDependencies {
  store?: UnpaidSubscriptionCheckoutSupersessionStore
  clientFactory?: RazorpayClientFactory
  cancellationClientFactory?:
    RazorpaySubscriptionCancellationClientFactory
  mappingStore?: WebhookDomainMappingStore
  commercialResolver?: SubscriptionCycleCommercialResolver
  persistObservation?: typeof persistSubscriptionProviderObservation
  now?: () => Date
}

export type UnpaidSubscriptionCheckoutSupersessionResult =
  | { outcome: 'none' }
  | {
      outcome: 'superseded'
      intentId: string
      previousPlanKey: 'plus' | 'pro'
      providerStatus: 'cancelled' | 'expired'
    }

/**
 * Clears only an older, different-plan acquisition checkout after Razorpay
 * proves that its exact subscription is terminal and has no payment evidence.
 */
export async function supersedeBlockingUnpaidSubscriptionCheckout(input: {
  userId: string
  providerMode: ProviderMode
  replacementPlanKey: 'plus' | 'pro'
  requestStartedAt: Date
}, dependencies: UnpaidSubscriptionCheckoutSupersessionDependencies = {}):
Promise<UnpaidSubscriptionCheckoutSupersessionResult> {
  const store = dependencies.store ??
    mongoUnpaidSubscriptionCheckoutSupersessionStore
  const blocking = await store.loadBlockingCheckout({
    userId: input.userId,
    providerMode: input.providerMode,
  })
  if (!blocking || blocking.intent.planKey === input.replacementPlanKey) {
    return { outcome: 'none' }
  }
  if (
    !Number.isFinite(input.requestStartedAt.getTime()) ||
    !blocking.intent.userId.equals(blocking.lease.userId) ||
    blocking.intent.userId.toHexString() !== input.userId ||
    blocking.intent.providerMode !== input.providerMode ||
    blocking.lease.providerMode !== input.providerMode ||
    !blocking.intent.id.equals(blocking.lease.ownerCheckoutIntentId) ||
    blocking.intent.razorpaySubscriptionId !==
      blocking.lease.razorpaySubscriptionId ||
    blocking.intent.createdAt >= input.requestStartedAt ||
    blocking.hasLocalPaymentEvidence
  ) {
    throw reviewRequired('The blocking checkout is not safely supersedable')
  }

  const intent = blocking.intent
  assertSubscriptionCommercialIntent(
    intent,
    {
      expected: {
        providerMode: input.providerMode,
        razorpaySubscriptionId: intent.razorpaySubscriptionId,
      },
      strictLocalShape: { receipt: intent.receipt },
    },
    () => {
      throw reviewRequired('The blocking checkout has invalid commercial data')
    },
  )
  assertSubscriptionLifecycleIntent(intent, () => {
    throw reviewRequired('The blocking checkout has invalid lifecycle data')
  })

  const mappingStore = dependencies.mappingStore ??
    mongoWebhookDomainMappingStore
  const context = await mappingStore.loadSubscriptionContext({
    providerMode: input.providerMode,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
  })
  if (!localContextMatches(blocking, context)) {
    throw reviewRequired('The blocked checkout no longer has exact lineage')
  }

  const resolver = dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver
  let subscription: RazorpaySubscriptionDto
  const cancellationFactory = dependencies.cancellationClientFactory ??
    createRazorpaySubscriptionCancellationClientFactory()
  const cancellationClient = cancellationFactory.forMode(input.providerMode)
  try {
    subscription = await cancellationClient.fetchSubscription(
      intent.razorpaySubscriptionId,
    )
  } catch (error) {
    throw providerUnavailable(
      'The blocked Razorpay subscription is temporarily unavailable',
      error,
    )
  }

  let terms
  try {
    terms = await resolver.resolve(intent)
  } catch (error) {
    throw reviewRequired(
      'The blocked checkout commercial terms could not be verified',
      error,
    )
  }
  if (!terms) {
    throw reviewRequired('The blocked checkout commercial terms are missing')
  }
  requireSubscriptionCommercialTerms({
    intent,
    terms,
    subscription,
    reject: () => {
      throw reviewRequired(
        'The blocked checkout does not match its Razorpay subscription',
      )
    },
  })
  if (!subscriptionHasNoPaidPeriod(subscription)) {
    throw reviewRequired('The blocked checkout has a paid provider period')
  }

  const clientFactory = dependencies.clientFactory ??
    createRazorpayClientFactory()
  await assertNoProviderPaymentEvidence({
    providerMode: input.providerMode,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    clientFactory,
  })

  if (!terminalUnpaidSubscription(subscription)) {
    if (subscription.status !== 'created') {
      throw reviewRequired(
        'The blocked Razorpay subscription is no longer pre-payment',
      )
    }
    try {
      subscription = await cancellationClient.cancelSubscriptionImmediately(
        intent.razorpaySubscriptionId,
      )
    } catch (error) {
      throw providerUnavailable(
        'The blocked Razorpay subscription could not be cancelled safely',
        error,
      )
    }
    if (!terminalUnpaidSubscription(subscription)) {
      throw reviewRequired(
        'Razorpay did not return terminal unpaid cancellation evidence',
      )
    }
  }

  await assertNoProviderPaymentEvidence({
    providerMode: input.providerMode,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    clientFactory,
  })

  const observedAt = (dependencies.now ?? (() => new Date()))()
  if (!Number.isFinite(observedAt.getTime())) {
    throw reviewRequired('The provider observation time is invalid')
  }
  const persist = dependencies.persistObservation ??
    persistSubscriptionProviderObservation
  let persisted
  try {
    persisted = await persist({
      providerMode: input.providerMode,
      providerObservedAt: observedAt,
      razorpaySubscriptionId: intent.razorpaySubscriptionId,
      subscription,
      localContext: context,
    }, {
      commercialResolver: resolver,
      now: () => observedAt,
    })
  } catch (error) {
    throw reviewRequired(
      'The terminal unpaid checkout could not be persisted safely',
      error,
    )
  }
  if (
    persisted.checkoutIntentId !== intent.id.toHexString() ||
    persisted.checkoutIntentStatus !== 'cancelled' ||
    persisted.leaseStatus !== 'released'
  ) {
    throw reviewRequired(
      'The terminal unpaid checkout was not released coherently',
    )
  }

  return {
    outcome: 'superseded',
    intentId: intent.id.toHexString(),
    previousPlanKey: intent.planKey,
    providerStatus: subscription.status as 'cancelled' | 'expired',
  }
}
