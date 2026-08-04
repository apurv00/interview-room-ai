import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  ConsumerSubscriptionLease,
  type ConsumerSubscriptionLeaseLane,
  type ConsumerSubscriptionLeaseReleaseReason,
  type ConsumerSubscriptionLeaseStatus,
} from '../models/ConsumerSubscriptionLease'
import {
  CheckoutIntent,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import {
  PlanChangeRequest,
  classifyPlanChangeControlLineage,
  type PlanChangeAdminControlV1,
  type PlanChangeRequestOperation,
  type PlanChangeRequestSource,
} from '../models/PlanChangeRequest'
import {
  Subscription,
  type SubscriptionSource,
  type SubscriptionStatus,
} from '../models/Subscription'
import type {
  CouponTerminalEvidenceSource,
  CouponTerminalReason,
} from '../models/CouponReservation'
import {
  RazorpayPaymentDtoSchema,
  RazorpaySubscriptionDtoSchema,
  type RazorpayPaymentDto,
  type RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import type {
  SubscriptionStateEffectInput,
  TrustedSubscriptionWebhookCheckout,
  TrustedWebhookSubscription,
} from './webhookDomainDispatchService'
import {
  assertSubscriptionCommercialIntent,
  assertSubscriptionLifecycleIntent,
  mongoSubscriptionCycleCommercialResolver,
  requireSubscriptionCommercialTerms,
  type OriginalSubscriptionCheckoutIntent,
  type ResolvedSubscriptionCommercialTerms,
  type SubscriptionCommercialInvariantFailure,
  type SubscriptionCycleCommercialResolver,
} from './subscriptionCycleFulfillmentService'
import {
  releaseCouponReservationInSession,
} from './couponReservationService'

const PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000

export const SUBSCRIPTION_STATE_DUNNING_EVIDENCE_SCHEMA_VERSION =
  'subscription_state_dunning_evidence_v1' as const

const STATE_EVENT_TYPES = [
  'subscription.authenticated',
  'subscription.activated',
  'subscription.completed',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
] as const

const TERMINAL_PROVIDER_STATUSES = [
  'cancelled',
  'completed',
  'expired',
] as const

const TERMINAL_LOCAL_STATUSES: readonly SubscriptionStatus[] = [
  'cancelled',
  'completed',
  'expired',
]

const PRE_PAYMENT_CANCELLABLE_INTENT_STATUSES:
readonly CheckoutIntentStatus[] = [
  'created',
  'remote_created',
  'checkout_opened',
  'authorization_pending',
  'abandoned',
  'failed',
  'cancelled',
]

export const SUBSCRIPTION_STATE_PERSISTENCE_ERROR_CODES = [
  'invalid_input',
  'reference_conflict',
  'local_context_missing',
  'local_context_conflict',
  'intent_not_found',
  'intent_conflict',
  'catalog_conflict',
  'coupon_conflict',
  'state_conflict',
  'persistence_conflict',
] as const
export type SubscriptionStatePersistenceErrorCode =
  (typeof SUBSCRIPTION_STATE_PERSISTENCE_ERROR_CODES)[number]

export class SubscriptionStatePersistenceError extends Error {
  readonly code: SubscriptionStatePersistenceErrorCode

  constructor(
    code: SubscriptionStatePersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionStatePersistenceError'
    this.code = code
  }
}

export interface SubscriptionStateCheckoutIntent
  extends OriginalSubscriptionCheckoutIntent {
  receipt: string
}

export interface SubscriptionStateLocalSubscription {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  checkoutIntentId?: mongoose.Types.ObjectId
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
  source: SubscriptionSource
}

export interface SubscriptionStateLease {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  lane: ConsumerSubscriptionLeaseLane
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId?: string
  status: ConsumerSubscriptionLeaseStatus
  remoteTerminalVerifiedAt?: Date
  releasedAt?: Date
  releaseReason?: ConsumerSubscriptionLeaseReleaseReason
  releasedBy?: mongoose.Types.ObjectId
}

export interface SubscriptionStateCommercialBinding {
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpayOfferId?: string
  couponCampaignId?: mongoose.Types.ObjectId
  couponCampaignRevision?: number
  discountedBillingCycles?: number
}

export interface SubscriptionStateDraft
  extends SubscriptionStateCommercialBinding {
  checkoutIntentId: mongoose.Types.ObjectId
  purpose: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt: Date
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  receipt: string
  intentCreatedAt: Date
  listPricePaise: number
  discountPaise: number
  payablePaise: number
  renewalPricePaise: number
  razorpaySubscriptionId: string
  remoteStatus: RazorpaySubscriptionDto['status']
  subscriptionSnapshot: RazorpaySubscriptionDto
  paymentSnapshot?: RazorpayPaymentDto
  expectedSubscriptionContextId?: mongoose.Types.ObjectId
}

export interface CreateSubscriptionStateInput {
  draft: SubscriptionStateDraft
  status: SubscriptionStatus
}

export interface UpdateSubscriptionStateInput {
  subscription: SubscriptionStateLocalSubscription
  status: SubscriptionStatus
}

export interface UpdateSubscriptionIntentInput {
  intent: SubscriptionStateCheckoutIntent
  status: CheckoutIntentStatus
}

export interface RecordTerminalLeaseInput {
  lease: SubscriptionStateLease
  observedAt: Date
}

export interface ReleaseSubscriptionCouponInput {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  terminalAt: Date
  reason: CouponTerminalReason
  evidenceSource: CouponTerminalEvidenceSource
  evidenceKey: string
}

export type SubscriptionStateCommercialAnalyticsEventName =
  | 'activation_pending'
  | 'subscription_pending'
  | 'subscription_halted'
export interface SubscriptionStateCommercialAnalyticsEvidence {
  readonly eventName: SubscriptionStateCommercialAnalyticsEventName
  readonly sourceEvidenceKey: string
  readonly observationSource: 'signed_webhook' | 'provider_fetch'
  readonly correlationId: string
  readonly subjectId: string
  readonly localSubscriptionId: string
  readonly providerMode: ProviderMode
  readonly occurredAt: Date
  readonly previousStatus: SubscriptionStatus | null
  readonly providerStatus: 'activation_pending' | 'pending' | 'halted'
  readonly pendingReason:
    | 'awaiting_mandate' | 'awaiting_entitlement' | null
  readonly productKey: 'plus' | 'pro'
  readonly catalogVersion: string
  readonly listPricePaise: number
  readonly discountPaise: number
  readonly payablePaise: number
  readonly renewalPricePaise: number
  readonly couponCampaignId: string | null
  readonly currentPeriodKey: string | null
  readonly currentPeriodStart: Date | null
  readonly currentPeriodEnd: Date | null
  readonly providerPaidCount: number
  readonly providerRemainingCount: number
  readonly providerMandateObserved: boolean
}
export interface SubscriptionStateCommercialAnalyticsProducer {
  appendSubscriptionStateTransitionInSession(
    evidence: () => SubscriptionStateCommercialAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface SubscriptionStateDunningEvidence {
  readonly schemaVersion:
    typeof SUBSCRIPTION_STATE_DUNNING_EVIDENCE_SCHEMA_VERSION
  readonly observationSource: 'signed_webhook' | 'provider_fetch'
  readonly sourceEvidenceKey: string
  readonly webhookInboxEventId: string | null
  readonly webhookEventType: string | null
  readonly providerMode: ProviderMode
  readonly localSubscriptionId: string
  readonly userId: string
  readonly providerSubscriptionId: string
  readonly persistedStatus: SubscriptionStatus
  readonly remoteStatus: RazorpaySubscriptionDto['status']
  readonly observedAt: Date
  readonly paidPeriod: {
    readonly key: string
    readonly start: Date
    readonly end: Date
  }
  readonly providerSnapshot: {
    readonly planId: string
    readonly offerId: string | null
    readonly totalCount: number
    readonly paidCount: number
    readonly remainingCount: number
    readonly currentStartEpochSeconds: number | null
    readonly currentEndEpochSeconds: number | null
    readonly startAtEpochSeconds: number | null
    readonly endAtEpochSeconds: number | null
    readonly chargeAtEpochSeconds: number | null
    readonly authorizationExpiresAtEpochSeconds: number | null
    readonly endedAtEpochSeconds: number | null
    readonly hasScheduledChanges: boolean | null
    readonly scheduledChangeAtEpochSeconds: number | null
    readonly createdAtEpochSeconds: number
  }
  readonly renewalCycleCaptured: boolean
}

export interface SubscriptionStateDunningProducer {
  appendSubscriptionDunningObservationInSession(
    evidence: () => SubscriptionStateDunningEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface SubscriptionStatePersistenceTransaction {
  loadIntent(
    intentId: mongoose.Types.ObjectId,
  ): Promise<SubscriptionStateCheckoutIntent | null>
  loadSubscription(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }): Promise<SubscriptionStateLocalSubscription | null>
  loadLease(input: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    lane: ConsumerSubscriptionLeaseLane
    ownerCheckoutIntentId: mongoose.Types.ObjectId
  }): Promise<SubscriptionStateLease | null>
  createSubscription(
    input: CreateSubscriptionStateInput,
  ): Promise<mongoose.Types.ObjectId>
  updateSubscriptionStatus(
    input: UpdateSubscriptionStateInput,
  ): Promise<boolean>
  updateIntentStatus(
    input: UpdateSubscriptionIntentInput,
  ): Promise<boolean>
  recordTerminalLease(
    input: RecordTerminalLeaseInput,
  ): Promise<boolean>
  releaseCouponReservation(
    input: ReleaseSubscriptionCouponInput,
  ): Promise<boolean>
  appendSubscriptionStateCommercialAnalytics?(
    producer: SubscriptionStateCommercialAnalyticsProducer,
    evidence: () => SubscriptionStateCommercialAnalyticsEvidence,
  ): Promise<void>
  appendSubscriptionDunningObservation?(
    producer: SubscriptionStateDunningProducer,
    evidence: () => SubscriptionStateDunningEvidence,
  ): Promise<void>
}

export interface SubscriptionStatePersistenceStore {
  loadOriginalIntent(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }): Promise<SubscriptionStateCheckoutIntent | null>
  runTransaction<T>(
    work: (
      transaction: SubscriptionStatePersistenceTransaction,
    ) => Promise<T>,
    producer?: SubscriptionStateCommercialAnalyticsProducer,
    dunningProducer?: SubscriptionStateDunningProducer,
  ): Promise<T>
}

export interface SubscriptionStatePersistenceDependencies {
  store?: SubscriptionStatePersistenceStore
  commercialResolver?: SubscriptionCycleCommercialResolver
  commercialAnalyticsProducer?:
    SubscriptionStateCommercialAnalyticsProducer
  dunningProducer?: SubscriptionStateDunningProducer
  now?: () => Date
}

export interface SubscriptionStatePersistenceResult {
  outcome: 'handled'
  operationKey: string
  checkoutIntentId: string
  localSubscriptionId: string
  subscriptionStatus: SubscriptionStatus
  checkoutIntentStatus: CheckoutIntentStatus
  leaseStatus: ConsumerSubscriptionLeaseStatus
  subscriptionCreated: boolean
  reused: boolean
  paidAccessPreservedThrough?: Date
}

type PaidPeriodEvidence =
  | {
      readonly exists: false
      readonly current: false
    }
  | {
      readonly exists: true
      readonly current: boolean
      readonly key: string
      readonly start: Date
      readonly end: Date
    }

interface SubscriptionStateObservationEvidence {
  source: Extract<
    CouponTerminalEvidenceSource,
    'signed_webhook' | 'provider_fetch'
  >
  key: string
  webhookInboxEventId: string | null
  webhookEventType: string | null
}

function failure(
  code: SubscriptionStatePersistenceErrorCode,
  message: string,
  cause?: unknown,
): SubscriptionStatePersistenceError {
  return new SubscriptionStatePersistenceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function validObjectId(value: unknown): value is mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId
}

function sameOptionalObjectId(
  left: mongoose.Types.ObjectId | undefined,
  right: mongoose.Types.ObjectId | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function sameOptionalDate(
  left: Date | undefined,
  right: Date | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    validDate(left) &&
    validDate(right) &&
    left.getTime() === right.getTime()
  )
}

function assertEffectEnvelope(
  input: SubscriptionStateEffectInput,
): {
  subscription: RazorpaySubscriptionDto
  payment?: RazorpayPaymentDto
} {
  if (
    !STATE_EVENT_TYPES.includes(
      input.eventType as (typeof STATE_EVENT_TYPES)[number],
    ) ||
    !mongoose.isValidObjectId(input.inboxEventId)
  ) {
    throw failure(
      'invalid_input',
      'Subscription state effect envelope is invalid',
    )
  }

  let subscription: RazorpaySubscriptionDto
  let payment: RazorpayPaymentDto | undefined
  try {
    subscription = RazorpaySubscriptionDtoSchema.parse(
      input.subscription,
    )
    payment = input.payment
      ? RazorpayPaymentDtoSchema.parse(input.payment)
      : undefined
  } catch (error) {
    throw failure(
      'invalid_input',
      'Normalized Razorpay state entities are invalid',
      error,
    )
  }

  if (
    subscription.providerMode !== input.providerMode ||
    subscription.id !== input.razorpaySubscriptionId
  ) {
    throw failure(
      'reference_conflict',
      'Fetched subscription does not match the verified effect envelope',
    )
  }

  const hasCurrentStart =
    subscription.currentStartEpochSeconds !== undefined
  const hasCurrentEnd =
    subscription.currentEndEpochSeconds !== undefined
  if (
    hasCurrentStart !== hasCurrentEnd ||
    (
      hasCurrentStart &&
      hasCurrentEnd &&
      (subscription.currentEndEpochSeconds as number) <=
        (subscription.currentStartEpochSeconds as number)
    ) ||
    subscription.paidCount > subscription.totalCount ||
    subscription.remainingCount > subscription.totalCount
  ) {
    throw failure(
      'reference_conflict',
      'Fetched subscription lifecycle counters are inconsistent',
    )
  }

  const hasPaymentReferences = Boolean(
    input.razorpayPaymentId ||
    input.razorpayOrderId ||
    input.razorpayInvoiceId,
  )
  if (!payment) {
    if (hasPaymentReferences) {
      throw failure(
        'reference_conflict',
        'Payment references lack a fetched normalized payment',
      )
    }
    return { subscription }
  }

  if (
    input.razorpayPaymentId !== payment.id ||
    (
      input.razorpayOrderId !== undefined &&
      input.razorpayOrderId !== payment.orderId
    ) ||
    (
      input.razorpayInvoiceId !== undefined &&
      input.razorpayInvoiceId !== payment.invoiceId
    ) ||
    payment.providerMode !== input.providerMode ||
    payment.subscriptionId !== subscription.id
  ) {
    throw failure(
      'reference_conflict',
      'Fetched state-event payment references are inconsistent',
    )
  }
  return { subscription, payment }
}

function assertCheckoutContext(
  checkout: TrustedSubscriptionWebhookCheckout | undefined,
  intent: SubscriptionStateCheckoutIntent,
  input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
    subscription: RazorpaySubscriptionDto
  },
): asserts checkout is TrustedSubscriptionWebhookCheckout {
  if (!checkout) {
    throw failure(
      'local_context_missing',
      'Customer subscription state requires its original checkout',
    )
  }
  if (
    !validObjectId(checkout._id) ||
    !validObjectId(checkout.userId) ||
    !validObjectId(intent.id) ||
    !validObjectId(intent.userId) ||
    !checkout._id.equals(intent.id) ||
    !checkout.userId.equals(intent.userId) ||
    checkout.providerMode !== input.providerMode ||
    intent.providerMode !== input.providerMode ||
    checkout.razorpaySubscriptionId !==
      input.razorpaySubscriptionId ||
    intent.razorpaySubscriptionId !==
      input.razorpaySubscriptionId ||
    checkout.planKey !== intent.planKey ||
    checkout.catalogVersion !== intent.catalogVersion ||
    checkout.receipt !== intent.receipt ||
    checkout.purpose !== intent.purpose ||
    !sameOptionalObjectId(
      checkout.planChangeRequestId,
      intent.planChangeRequestId,
    ) ||
    checkout.leaseLane !== intent.leaseLane ||
    !sameOptionalDate(
      checkout.requestedStartAt,
      intent.requestedStartAt,
    ) ||
    !sameOptionalDate(
      checkout.authorizationExpiresAt,
      intent.authorizationExpiresAt,
    ) ||
    input.subscription.notes.checkout_receipt !== intent.receipt ||
    input.subscription.notes.checkout_intent_id !==
      intent.id.toString() ||
    input.subscription.notes.catalog_version !==
      intent.catalogVersion ||
    input.subscription.notes.checkout_purpose !== intent.purpose ||
    input.subscription.notes.subscription_lease_lane !==
      intent.leaseLane ||
    input.subscription.notes.plan_change_request_id !==
      intent.planChangeRequestId?.toString() ||
    input.subscription.startAtEpochSeconds !==
      (
        intent.requestedStartAt
          ? Math.floor(intent.requestedStartAt.getTime() / 1_000)
          : undefined
      ) ||
    input.subscription.authorizationExpiresAtEpochSeconds !==
      (
        intent.authorizationExpiresAt
          ? Math.floor(
              intent.authorizationExpiresAt.getTime() / 1_000,
            )
          : undefined
      )
  ) {
    throw failure(
      'local_context_conflict',
      'Checkout, receipt, user, or subscription correlation conflicts',
    )
  }
}

function assertSubscriptionContext(
  context: TrustedWebhookSubscription | undefined,
  checkout: TrustedSubscriptionWebhookCheckout,
  intent: SubscriptionStateCheckoutIntent,
  subscription: RazorpaySubscriptionDto,
): void {
  if (!context) return
  if (
    !validObjectId(context._id) ||
    !validObjectId(context.userId) ||
    !context.userId.equals(checkout.userId) ||
    context.providerMode !== checkout.providerMode ||
    context.planKey !== checkout.planKey ||
    context.catalogVersion !== checkout.catalogVersion ||
    context.razorpayPlanId !== subscription.planId ||
    context.razorpaySubscriptionId !== subscription.id ||
    !context.checkoutIntentId?.equals(checkout._id) ||
    !sameOptionalObjectId(
      context.planChangeRequestId,
      intent.planChangeRequestId,
    ) ||
    !sameOptionalObjectId(
      context.replacesSubscriptionId,
      intent.replacesSubscriptionId,
    ) ||
    context.leaseLane !== checkout.leaseLane ||
    !sameOptionalDate(
      context.requestedStartAt,
      checkout.requestedStartAt,
    ) ||
    !sameOptionalDate(
      context.authorizationExpiresAt,
      checkout.authorizationExpiresAt,
    ) ||
    context.source !== 'customer' ||
    context.status === 'review'
  ) {
    throw failure(
      'local_context_conflict',
      'Trusted checkout and subscription context disagree',
    )
  }
}

function assertIntentShape(
  intent: SubscriptionStateCheckoutIntent,
): asserts intent is SubscriptionStateCheckoutIntent & {
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  quote: SubscriptionStateCheckoutIntent['quote'] & {
    renewalPricePaise: number
  }
  purpose: CheckoutIntentPurpose
  leaseLane: ConsumerSubscriptionLeaseLane
  authorizationExpiresAt: Date
  receipt: string
} {
  assertSubscriptionCommercialIntent(
    intent,
    { strictLocalShape: { receipt: intent.receipt } },
    rejectStateCommercialInvariant,
  )
  assertSubscriptionLifecycleIntent(
    intent,
    rejectStateCommercialInvariant,
  )
}

function rejectStateCommercialInvariant(
  conflict: SubscriptionCommercialInvariantFailure,
): never {
  if (conflict === 'catalog') {
    throw failure(
      'catalog_conflict',
      'Immutable catalog, plan key, or Razorpay Plan binding conflicts',
    )
  }
  if (
    conflict === 'coupon' ||
    conflict === 'coupon_contamination'
  ) {
    throw failure(
      'coupon_conflict',
      conflict === 'coupon_contamination'
        ? 'Non-coupon checkout is contaminated by an Offer or coupon'
        : 'Immutable coupon revision and Razorpay Offer binding conflict',
    )
  }
  throw failure(
    'intent_conflict',
    conflict === 'intent'
      ? 'Original subscription checkout intent is inconsistent'
      : 'Original subscription coupon tuple is inconsistent',
  )
}

function commercialBinding(
  intent: SubscriptionStateCheckoutIntent & {
    planKey: 'plus' | 'pro'
    razorpaySubscriptionId: string
  },
  terms: ResolvedSubscriptionCommercialTerms,
  subscription: RazorpaySubscriptionDto,
): SubscriptionStateCommercialBinding {
  const { plan, coupon } = requireSubscriptionCommercialTerms({
    intent,
    terms,
    subscription,
    strictContentHashes: true,
    reject: rejectStateCommercialInvariant,
  })
  return {
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    razorpayPlanId: plan.razorpayPlanId,
    ...(coupon
      ? {
          razorpayOfferId: coupon.razorpayOfferId,
          couponCampaignId: coupon.campaignId,
          couponCampaignRevision: coupon.revision,
          discountedBillingCycles: coupon.discountedBillingCycles,
        }
      : {}),
  }
}

function exactIntent(
  intent: SubscriptionStateCheckoutIntent,
  draft: SubscriptionStateDraft,
): boolean {
  const quote = intent.quote
  const expectedHasCoupon = draft.couponCampaignId !== undefined
  return (
    intent.id.equals(draft.checkoutIntentId) &&
    intent.userId.equals(draft.userId) &&
    intent.kind === 'subscription' &&
    intent.providerMode === draft.providerMode &&
    intent.purpose === draft.purpose &&
    sameOptionalObjectId(
      intent.planChangeRequestId,
      draft.planChangeRequestId,
    ) &&
    sameOptionalObjectId(
      intent.replacesSubscriptionId,
      draft.replacesSubscriptionId,
    ) &&
    intent.leaseLane === draft.leaseLane &&
    sameOptionalDate(
      intent.requestedStartAt,
      draft.requestedStartAt,
    ) &&
    sameOptionalDate(
      intent.authorizationExpiresAt,
      draft.authorizationExpiresAt,
    ) &&
    intent.planKey === draft.planKey &&
    intent.catalogVersion === draft.catalogVersion &&
    intent.razorpaySubscriptionId ===
      draft.razorpaySubscriptionId &&
    intent.receipt === draft.receipt &&
    validDate(intent.createdAt) &&
    intent.createdAt.getTime() === draft.intentCreatedAt.getTime() &&
    quote.currency === 'INR' &&
    quote.listPricePaise === draft.listPricePaise &&
    quote.discountPaise === draft.discountPaise &&
    quote.payablePaise === draft.payablePaise &&
    quote.renewalPricePaise === draft.renewalPricePaise &&
    (
      expectedHasCoupon
        ? Boolean(
            quote.couponCampaignId &&
            draft.couponCampaignId &&
            quote.couponCampaignId.equals(
              draft.couponCampaignId,
            ) &&
            quote.couponCampaignRevision ===
              draft.couponCampaignRevision &&
            quote.discountedBillingCycles ===
              draft.discountedBillingCycles,
          )
        : (
            quote.discountPaise === 0 &&
            quote.couponCampaignId === undefined &&
            quote.couponCampaignRevision === undefined &&
            quote.discountedBillingCycles === undefined
          )
    )
  )
}

function exactSubscription(
  subscription: SubscriptionStateLocalSubscription,
  draft: SubscriptionStateDraft,
): boolean {
  const couponMatches = draft.couponCampaignId
    ? Boolean(
        subscription.couponCampaignId &&
        subscription.couponCampaignId.equals(
          draft.couponCampaignId,
        ) &&
        Number.isSafeInteger(
          subscription.discountedCyclesRemaining,
        ) &&
        (subscription.discountedCyclesRemaining ?? -1) >= 0 &&
        (subscription.discountedCyclesRemaining ?? Infinity) <=
          (draft.discountedBillingCycles ?? -1),
      )
    : (
        subscription.couponCampaignId === undefined &&
        (
          subscription.discountedCyclesRemaining === undefined ||
          subscription.discountedCyclesRemaining === 0
        )
      )
  return (
    subscription.userId.equals(draft.userId) &&
    subscription.providerMode === draft.providerMode &&
    subscription.planKey === draft.planKey &&
    subscription.catalogVersion === draft.catalogVersion &&
    subscription.razorpayPlanId === draft.razorpayPlanId &&
    subscription.razorpaySubscriptionId ===
      draft.razorpaySubscriptionId &&
    subscription.checkoutIntentId instanceof
      mongoose.Types.ObjectId &&
    subscription.checkoutIntentId.equals(draft.checkoutIntentId) &&
    sameOptionalObjectId(
      subscription.planChangeRequestId,
      draft.planChangeRequestId,
    ) &&
    sameOptionalObjectId(
      subscription.replacesSubscriptionId,
      draft.replacesSubscriptionId,
    ) &&
    subscription.leaseLane === draft.leaseLane &&
    sameOptionalDate(
      subscription.requestedStartAt,
      draft.requestedStartAt,
    ) &&
    sameOptionalDate(
      subscription.authorizationExpiresAt,
      draft.authorizationExpiresAt,
    ) &&
    subscription.source === 'customer' &&
    couponMatches
  )
}

function paidPeriodEvidence(
  subscription: SubscriptionStateLocalSubscription | null,
  observedAt: Date,
): PaidPeriodEvidence {
  if (!subscription) return { exists: false, current: false }
  const tuple = [
    subscription.currentPeriodKey,
    subscription.currentPeriodStart,
    subscription.currentPeriodEnd,
  ]
  const present = tuple.filter((value) => value !== undefined).length
  if (present === 0) return { exists: false, current: false }
  if (
    present !== 3 ||
    typeof subscription.currentPeriodKey !== 'string' ||
    subscription.currentPeriodKey.trim().length === 0 ||
    !validDate(subscription.currentPeriodStart) ||
    !validDate(subscription.currentPeriodEnd) ||
    subscription.currentPeriodEnd <= subscription.currentPeriodStart ||
    subscription.currentPeriodStart.getTime() >
      observedAt.getTime() + PROVIDER_CLOCK_SKEW_MS
  ) {
    throw failure(
      'state_conflict',
      'Local subscription paid-period evidence is incomplete or invalid',
    )
  }
  return {
    exists: true,
    current:
      subscription.currentPeriodEnd > observedAt &&
      subscription.currentPeriodStart.getTime() <=
        observedAt.getTime() + PROVIDER_CLOCK_SKEW_MS,
    key: subscription.currentPeriodKey,
    start: new Date(subscription.currentPeriodStart),
    end: new Date(subscription.currentPeriodEnd),
  }
}

function mappedSubscriptionStatus(
  remoteStatus: RazorpaySubscriptionDto['status'],
  hasPaidCurrentPeriod: boolean,
): SubscriptionStatus {
  if (remoteStatus === 'authenticated') return 'authenticated'
  if (remoteStatus === 'created') return 'activation_pending'
  if (remoteStatus === 'active') {
    return hasPaidCurrentPeriod ? 'active' : 'activation_pending'
  }
  return remoteStatus
}

function targetIntentStatus(
  current: CheckoutIntentStatus,
  remoteStatus: RazorpaySubscriptionDto['status'],
  paidPeriodExists: boolean,
): CheckoutIntentStatus {
  if (current === 'review') {
    throw failure(
      'intent_conflict',
      'Checkout intent under review cannot be advanced automatically',
    )
  }
  if (paidPeriodExists) {
    if (current !== 'fulfilled') {
      throw failure(
        'state_conflict',
        'Paid-period evidence lacks an atomically fulfilled checkout',
      )
    }
    return 'fulfilled'
  }
  if (current === 'fulfilled') {
    throw failure(
      'state_conflict',
      'Fulfilled checkout lacks local paid-period evidence',
    )
  }
  if (current === 'payment_captured') return current

  if (
    TERMINAL_PROVIDER_STATUSES.includes(
      remoteStatus as (typeof TERMINAL_PROVIDER_STATUSES)[number],
    )
  ) {
    if (!PRE_PAYMENT_CANCELLABLE_INTENT_STATUSES.includes(current)) {
      throw failure(
        'intent_conflict',
        'Terminal pre-payment checkout has an unsafe local state',
      )
    }
    return 'cancelled'
  }
  if (remoteStatus === 'created') return 'remote_created'
  return 'authorization_pending'
}

function assertLease(
  lease: SubscriptionStateLease | null,
  draft: SubscriptionStateDraft,
  terminal: boolean,
): asserts lease is SubscriptionStateLease {
  if (!lease) {
    throw failure(
      'local_context_missing',
      'Subscription state lacks its consumer mandate lease',
    )
  }
  if (
    !lease.userId.equals(draft.userId) ||
    lease.providerMode !== draft.providerMode ||
    lease.lane !== draft.leaseLane ||
    !lease.ownerCheckoutIntentId.equals(draft.checkoutIntentId) ||
    lease.razorpaySubscriptionId !==
      draft.razorpaySubscriptionId ||
    lease.status === 'review'
  ) {
    throw failure(
      'local_context_conflict',
      'Consumer subscription lease conflicts with the checkout',
    )
  }
  if (!terminal && lease.status === 'released') {
    throw failure(
      'state_conflict',
      'Fetched non-terminal mandate conflicts with a released lease',
    )
  }
  if (
    lease.status === 'released' &&
    (
      !validDate(lease.releasedAt) ||
      !lease.releaseReason ||
      (
        lease.releaseReason === 'remote_terminal_verified' &&
        !validDate(lease.remoteTerminalVerifiedAt)
      ) ||
      (
        lease.releaseReason === 'operator_resolved' &&
        !validObjectId(lease.releasedBy)
      )
    )
  ) {
    throw failure(
      'state_conflict',
      'Released mandate lease lacks explicit release evidence',
    )
  }
}

function assertSafeSubscriptionTransition(
  current: SubscriptionStatus,
  target: SubscriptionStatus,
): void {
  if (current === 'review') {
    throw failure(
      'state_conflict',
      'Subscription under review cannot be changed automatically',
    )
  }
  if (
    TERMINAL_LOCAL_STATUSES.includes(current) &&
    target !== current
  ) {
    throw failure(
      'state_conflict',
      'Terminal local subscription state is absorbing',
    )
  }
}

function operationKey(
  draft: SubscriptionStateDraft,
  status: SubscriptionStatus,
): string {
  return `${draft.providerMode}:${draft.razorpaySubscriptionId}` +
    `:subscription_state:${draft.remoteStatus}:${status}`
}

function couponTerminalReason(
  status: RazorpaySubscriptionDto['status'],
): CouponTerminalReason {
  if (status === 'cancelled') {
    return 'provider_subscription_cancelled_unpaid'
  }
  if (status === 'completed') {
    return 'provider_subscription_completed_unpaid'
  }
  if (status === 'expired') {
    return 'provider_subscription_expired_unpaid'
  }
  throw failure(
    'state_conflict',
    'Coupon capacity requires terminal provider evidence',
  )
}

async function persistTransactionState(
  transaction: SubscriptionStatePersistenceTransaction,
  draft: SubscriptionStateDraft,
  observedAt: Date,
  observationEvidence: SubscriptionStateObservationEvidence,
  producer?: SubscriptionStateCommercialAnalyticsProducer,
  dunningProducer?: SubscriptionStateDunningProducer,
): Promise<SubscriptionStatePersistenceResult> {
  const intent = await transaction.loadIntent(draft.checkoutIntentId)
  if (!intent || !exactIntent(intent, draft)) {
    throw failure(
      'intent_conflict',
      'Checkout intent changed before lifecycle persistence',
    )
  }
  assertIntentShape(intent)

  let subscription = await transaction.loadSubscription({
    providerMode: draft.providerMode,
    razorpaySubscriptionId: draft.razorpaySubscriptionId,
  })
  if (
    draft.expectedSubscriptionContextId &&
    (
      !subscription ||
      !subscription.id.equals(
        draft.expectedSubscriptionContextId,
      )
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Trusted subscription context disappeared or changed',
    )
  }
  if (subscription && !exactSubscription(subscription, draft)) {
    throw failure(
      'local_context_conflict',
      'Persisted subscription conflicts with immutable checkout terms',
    )
  }

  const paidPeriod = paidPeriodEvidence(subscription, observedAt)
  const targetSubscription = mappedSubscriptionStatus(
    draft.remoteStatus,
    paidPeriod.current,
  )
  const targetIntent = targetIntentStatus(
    intent.status,
    draft.remoteStatus,
    paidPeriod.exists,
  )
  const terminal = TERMINAL_PROVIDER_STATUSES.includes(
    draft.remoteStatus as (typeof TERMINAL_PROVIDER_STATUSES)[number],
  )
  const lease = await transaction.loadLease({
    userId: draft.userId,
    providerMode: draft.providerMode,
    lane: draft.leaseLane,
    ownerCheckoutIntentId: draft.checkoutIntentId,
  })
  assertLease(lease, draft, terminal)

  const previousSubscriptionStatus = subscription?.status ?? null
  let subscriptionCreated = false
  let stateChanged = false
  let localSubscriptionId: mongoose.Types.ObjectId
  if (!subscription) {
    localSubscriptionId = await transaction.createSubscription({
      draft,
      status: targetSubscription,
    })
    subscriptionCreated = true
    stateChanged = true
    subscription = {
      id: localSubscriptionId,
      userId: draft.userId,
      providerMode: draft.providerMode,
      checkoutIntentId: draft.checkoutIntentId,
      planChangeRequestId: draft.planChangeRequestId,
      replacesSubscriptionId: draft.replacesSubscriptionId,
      leaseLane: draft.leaseLane,
      requestedStartAt: draft.requestedStartAt,
      authorizationExpiresAt: draft.authorizationExpiresAt,
      planKey: draft.planKey,
      catalogVersion: draft.catalogVersion,
      razorpayPlanId: draft.razorpayPlanId,
      razorpaySubscriptionId: draft.razorpaySubscriptionId,
      status: targetSubscription,
      couponCampaignId: draft.couponCampaignId,
      discountedCyclesRemaining: draft.discountedBillingCycles,
      source: 'customer',
    }
  } else {
    localSubscriptionId = subscription.id
    assertSafeSubscriptionTransition(
      subscription.status,
      targetSubscription,
    )
    if (subscription.status !== targetSubscription) {
      const updated = await transaction.updateSubscriptionStatus({
        subscription,
        status: targetSubscription,
      })
      if (!updated) {
        throw failure(
          'persistence_conflict',
          'Subscription lifecycle CAS did not match',
        )
      }
      stateChanged = true
    }
  }

  if (intent.status !== targetIntent) {
    const updated = await transaction.updateIntentStatus({
      intent,
      status: targetIntent,
    })
    if (!updated) {
      throw failure(
        'persistence_conflict',
        'Checkout intent lifecycle CAS did not match',
      )
    }
    stateChanged = true
  }

  let leaseStatus = lease.status
  if (
    terminal &&
    (
      lease.status !== 'released' ||
      !validDate(lease.remoteTerminalVerifiedAt)
    )
  ) {
    const updated = await transaction.recordTerminalLease({
      lease,
      observedAt,
    })
    if (!updated) {
      throw failure(
        'persistence_conflict',
        'Terminal mandate lease CAS did not match',
      )
    }
    leaseStatus = 'released'
    stateChanged = true
  }

  if (
    terminal &&
    !paidPeriod.exists &&
    draft.couponCampaignId
  ) {
    const released = await transaction.releaseCouponReservation({
      providerMode: draft.providerMode,
      campaignId: draft.couponCampaignId,
      userId: draft.userId,
      checkoutIntentId: draft.checkoutIntentId,
      terminalAt: observedAt,
      reason: couponTerminalReason(draft.remoteStatus),
      evidenceSource: observationEvidence.source,
      evidenceKey: observationEvidence.key,
    })
    stateChanged ||= released
  }

  if (
    producer &&
    (
      targetSubscription === 'activation_pending' ||
      targetSubscription === 'authenticated' ||
      targetSubscription === 'pending' ||
      targetSubscription === 'halted'
    ) &&
    previousSubscriptionStatus !== targetSubscription
  ) {
    if (!transaction.appendSubscriptionStateCommercialAnalytics) {
      throw failure(
        'persistence_conflict',
        'Subscription state analytics lacks the caller transaction',
      )
    }
    const eventName =
      targetSubscription === 'activation_pending' ||
      targetSubscription === 'authenticated'
        ? 'activation_pending'
        : targetSubscription === 'pending'
        ? 'subscription_pending'
        : 'subscription_halted'
    await transaction.appendSubscriptionStateCommercialAnalytics(
      producer,
      () => ({
        eventName,
        sourceEvidenceKey: observationEvidence.key,
        observationSource: observationEvidence.source,
        correlationId: draft.checkoutIntentId.toHexString(),
        subjectId: draft.userId.toHexString(),
        localSubscriptionId: localSubscriptionId.toHexString(),
        providerMode: draft.providerMode,
        occurredAt: observedAt,
        previousStatus: previousSubscriptionStatus,
        providerStatus: eventName === 'activation_pending'
          ? 'activation_pending'
          : targetSubscription as 'pending' | 'halted',
        pendingReason: eventName === 'activation_pending'
          ? draft.remoteStatus === 'created'
            ? 'awaiting_mandate'
            : 'awaiting_entitlement'
          : null,
        productKey: draft.planKey,
        catalogVersion: draft.catalogVersion,
        listPricePaise: draft.listPricePaise,
        discountPaise: draft.discountPaise,
        payablePaise: draft.payablePaise,
        renewalPricePaise: draft.renewalPricePaise,
        couponCampaignId:
          draft.couponCampaignId?.toHexString() ?? null,
        currentPeriodKey:
          subscription.currentPeriodKey ?? null,
        currentPeriodStart:
          subscription.currentPeriodStart ?? null,
        currentPeriodEnd:
          subscription.currentPeriodEnd ?? null,
        providerPaidCount: draft.subscriptionSnapshot.paidCount,
        providerRemainingCount: draft.subscriptionSnapshot.remainingCount,
        providerMandateObserved: draft.remoteStatus === 'authenticated',
      }),
    )
  }

  if (
    dunningProducer &&
    paidPeriod.exists &&
    paidPeriod.start <= observedAt
  ) {
    if (!transaction.appendSubscriptionDunningObservation) {
      throw failure(
        'persistence_conflict',
        'Subscription dunning producer lacks the caller transaction',
      )
    }
    await transaction.appendSubscriptionDunningObservation(
      dunningProducer,
      () => ({
        schemaVersion:
          SUBSCRIPTION_STATE_DUNNING_EVIDENCE_SCHEMA_VERSION,
        observationSource: observationEvidence.source,
        sourceEvidenceKey: observationEvidence.key,
        webhookInboxEventId:
          observationEvidence.webhookInboxEventId,
        webhookEventType: observationEvidence.webhookEventType,
        providerMode: draft.providerMode,
        localSubscriptionId: localSubscriptionId.toHexString(),
        userId: draft.userId.toHexString(),
        providerSubscriptionId: draft.razorpaySubscriptionId,
        persistedStatus: targetSubscription,
        remoteStatus: draft.remoteStatus,
        observedAt: new Date(observedAt),
        paidPeriod: {
          key: paidPeriod.key,
          start: new Date(paidPeriod.start),
          end: new Date(paidPeriod.end),
        },
        providerSnapshot: {
          planId: draft.subscriptionSnapshot.planId,
          offerId: draft.subscriptionSnapshot.offerId ?? null,
          totalCount: draft.subscriptionSnapshot.totalCount,
          paidCount: draft.subscriptionSnapshot.paidCount,
          remainingCount:
            draft.subscriptionSnapshot.remainingCount,
          currentStartEpochSeconds:
            draft.subscriptionSnapshot
              .currentStartEpochSeconds ?? null,
          currentEndEpochSeconds:
            draft.subscriptionSnapshot.currentEndEpochSeconds ?? null,
          startAtEpochSeconds:
            draft.subscriptionSnapshot.startAtEpochSeconds ?? null,
          endAtEpochSeconds:
            draft.subscriptionSnapshot.endAtEpochSeconds ?? null,
          chargeAtEpochSeconds:
            draft.subscriptionSnapshot.chargeAtEpochSeconds ?? null,
          authorizationExpiresAtEpochSeconds:
            draft.subscriptionSnapshot
              .authorizationExpiresAtEpochSeconds ?? null,
          endedAtEpochSeconds:
            draft.subscriptionSnapshot.endedAtEpochSeconds ?? null,
          hasScheduledChanges:
            draft.subscriptionSnapshot.hasScheduledChanges ?? null,
          scheduledChangeAtEpochSeconds:
            draft.subscriptionSnapshot
              .scheduledChangeAtEpochSeconds ?? null,
          createdAtEpochSeconds:
            draft.subscriptionSnapshot.createdAtEpochSeconds,
        },
        renewalCycleCaptured:
          draft.remoteStatus === 'active' &&
          targetSubscription === 'active' &&
          paidPeriod.current,
      }),
    )
  }

  return {
    outcome: 'handled',
    operationKey: operationKey(draft, targetSubscription),
    checkoutIntentId: draft.checkoutIntentId.toString(),
    localSubscriptionId: localSubscriptionId.toString(),
    subscriptionStatus: targetSubscription,
    checkoutIntentStatus: targetIntent,
    leaseStatus,
    subscriptionCreated,
    reused: !stateChanged,
    ...(paidPeriod.current && paidPeriod.end
      ? { paidAccessPreservedThrough: paidPeriod.end }
      : {}),
  }
}

interface LeanIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: OriginalSubscriptionCheckoutIntent['kind']
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId?: string
  receipt: string
  createdAt: Date
  quoteSnapshot: OriginalSubscriptionCheckoutIntent['quote']
}

interface LeanPlanChangeLineage {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  providerMode?: ProviderMode
  checkoutIntentId?: mongoose.Types.ObjectId
  fromSubscriptionId?: mongoose.Types.ObjectId
  operation: PlanChangeRequestOperation
  toPlanKey: 'free' | 'plus' | 'pro'
  targetCatalogVersion: string
  requestedEffectiveAt: Date
  authorizationExpiresAt?: Date
}

interface LeanSubscription {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  checkoutIntentId?: mongoose.Types.ObjectId
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
  source: SubscriptionSource
}

interface LeanLease {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  lane: ConsumerSubscriptionLeaseLane
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId?: string
  status: ConsumerSubscriptionLeaseStatus
  remoteTerminalVerifiedAt?: Date
  releasedAt?: Date
  releaseReason?: ConsumerSubscriptionLeaseReleaseReason
  releasedBy?: mongoose.Types.ObjectId
}

function exactPlanChangeSource(
  intent: LeanIntent,
  request: LeanPlanChangeLineage | null,
): mongoose.Types.ObjectId | undefined {
  if (
    !intent.planChangeRequestId ||
    !request ||
    (
      intent.purpose !== 'replacement' &&
      intent.purpose !== 'resubscribe'
    ) ||
    !request._id.equals(intent.planChangeRequestId) ||
    !request.userId.equals(intent.userId) ||
    classifyPlanChangeControlLineage(request) !== 'customer' ||
    request.providerMode !== intent.providerMode ||
    !request.checkoutIntentId?.equals(intent._id) ||
    !request.fromSubscriptionId ||
    request.operation !==
      (intent.purpose === 'replacement'
        ? 'tier_change'
        : 'resubscribe') ||
    request.toPlanKey !== intent.planKey ||
    request.targetCatalogVersion !== intent.catalogVersion ||
    !validDate(request.requestedEffectiveAt) ||
    !validDate(intent.requestedStartAt) ||
    request.requestedEffectiveAt.getTime() !==
      intent.requestedStartAt.getTime() ||
    !validDate(request.authorizationExpiresAt) ||
    !validDate(intent.authorizationExpiresAt) ||
    request.authorizationExpiresAt.getTime() !==
      intent.authorizationExpiresAt.getTime()
  ) {
    return undefined
  }
  return request.fromSubscriptionId
}

function toIntent(
  intent: LeanIntent,
  replacesSubscriptionId?: mongoose.Types.ObjectId,
): SubscriptionStateCheckoutIntent {
  return {
    id: intent._id,
    userId: intent.userId,
    kind: intent.kind,
    providerMode: intent.providerMode,
    status: intent.status,
    purpose: intent.purpose,
    planChangeRequestId: intent.planChangeRequestId,
    replacesSubscriptionId,
    leaseLane: intent.leaseLane,
    requestedStartAt: intent.requestedStartAt,
    authorizationExpiresAt: intent.authorizationExpiresAt,
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    receipt: intent.receipt,
    createdAt: intent.createdAt,
    quote: intent.quoteSnapshot,
  }
}

function toSubscription(
  subscription: LeanSubscription,
): SubscriptionStateLocalSubscription {
  return {
    id: subscription._id,
    userId: subscription.userId,
    providerMode: subscription.providerMode,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    razorpayPlanId: subscription.razorpayPlanId,
    razorpaySubscriptionId:
      subscription.razorpaySubscriptionId,
    checkoutIntentId: subscription.checkoutIntentId,
    planChangeRequestId: subscription.planChangeRequestId,
    replacesSubscriptionId: subscription.replacesSubscriptionId,
    leaseLane: subscription.leaseLane,
    requestedStartAt: subscription.requestedStartAt,
    authorizationExpiresAt: subscription.authorizationExpiresAt,
    status: subscription.status,
    currentPeriodKey: subscription.currentPeriodKey,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    couponCampaignId: subscription.couponCampaignId,
    discountedCyclesRemaining:
      subscription.discountedCyclesRemaining,
    source: subscription.source,
  }
}

function toLease(lease: LeanLease): SubscriptionStateLease {
  return {
    id: lease._id,
    userId: lease.userId,
    providerMode: lease.providerMode,
    lane: lease.lane,
    ownerCheckoutIntentId: lease.ownerCheckoutIntentId,
    razorpaySubscriptionId: lease.razorpaySubscriptionId,
    status: lease.status,
    remoteTerminalVerifiedAt: lease.remoteTerminalVerifiedAt,
    releasedAt: lease.releasedAt,
    releaseReason: lease.releaseReason,
    releasedBy: lease.releasedBy,
  }
}

async function loadMongoIntent(input: {
  providerMode?: ProviderMode
  razorpaySubscriptionId?: string
  intentId?: mongoose.Types.ObjectId
  session?: ClientSession
}): Promise<SubscriptionStateCheckoutIntent | null> {
  const filter = input.intentId
    ? { _id: input.intentId }
    : {
        providerMode: input.providerMode,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
      }
  const query = CheckoutIntent.findOne(filter).select([
    '_id',
    'userId',
    'kind',
    'providerMode',
    'status',
    'purpose',
    'planChangeRequestId',
    'leaseLane',
    'requestedStartAt',
    'authorizationExpiresAt',
    'planKey',
    'catalogVersion',
    'razorpaySubscriptionId',
    'receipt',
    'createdAt',
    'quoteSnapshot.currency',
    'quoteSnapshot.listPricePaise',
    'quoteSnapshot.discountPaise',
    'quoteSnapshot.payablePaise',
    'quoteSnapshot.renewalPricePaise',
    'quoteSnapshot.discountedBillingCycles',
    'quoteSnapshot.couponCampaignId',
    'quoteSnapshot.couponCampaignRevision',
  ].join(' '))
  if (input.session) query.session(input.session)
  const intent = await query.lean<LeanIntent>()
  if (!intent) return null
  let request: LeanPlanChangeLineage | null = null
  if (intent.planChangeRequestId) {
    const requestQuery = PlanChangeRequest.findById(
      intent.planChangeRequestId,
    ).select([
      '_id',
      'userId',
      'actorUserId',
      'source',
      'adminControl',
      'providerMode',
      'checkoutIntentId',
      'fromSubscriptionId',
      'operation',
      'toPlanKey',
      'targetCatalogVersion',
      'requestedEffectiveAt',
      'authorizationExpiresAt',
    ].join(' '))
    if (input.session) requestQuery.session(input.session)
    request = await requestQuery.lean<LeanPlanChangeLineage>()
  }
  return toIntent(
    intent,
    exactPlanChangeSource(intent, request),
  )
}

function subscriptionPeriodFilter(
  subscription: SubscriptionStateLocalSubscription,
): Record<string, unknown> {
  if (
    subscription.currentPeriodKey === undefined &&
    subscription.currentPeriodStart === undefined &&
    subscription.currentPeriodEnd === undefined
  ) {
    return {
      currentPeriodKey: { $exists: false },
      currentPeriodStart: { $exists: false },
      currentPeriodEnd: { $exists: false },
    }
  }
  return {
    currentPeriodKey: subscription.currentPeriodKey,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
  }
}

function mongoTransaction(
  session: ClientSession,
  producer?: SubscriptionStateCommercialAnalyticsProducer,
  dunningProducer?: SubscriptionStateDunningProducer,
): SubscriptionStatePersistenceTransaction {
  return {
    async loadIntent(intentId) {
      return loadMongoIntent({ intentId, session })
    },

    async loadSubscription(input) {
      const subscription = await Subscription.findOne({
        providerMode: input.providerMode,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
      }).session(session).lean<LeanSubscription>()
      return subscription ? toSubscription(subscription) : null
    },

    async loadLease(input) {
      const lease = await ConsumerSubscriptionLease.findOne({
        userId: input.userId,
        providerMode: input.providerMode,
        lane: input.lane,
        ownerCheckoutIntentId: input.ownerCheckoutIntentId,
      }).session(session).lean<LeanLease>()
      return lease ? toLease(lease) : null
    },

    async createSubscription(input) {
      const { draft, status } = input
      const created = await Subscription.create([{
        userId: draft.userId,
        providerMode: draft.providerMode,
        planKey: draft.planKey,
        catalogVersion: draft.catalogVersion,
        razorpayPlanId: draft.razorpayPlanId,
        razorpaySubscriptionId: draft.razorpaySubscriptionId,
        checkoutIntentId: draft.checkoutIntentId,
        planChangeRequestId: draft.planChangeRequestId,
        replacesSubscriptionId: draft.replacesSubscriptionId,
        leaseLane: draft.leaseLane,
        requestedStartAt: draft.requestedStartAt,
        authorizationExpiresAt: draft.authorizationExpiresAt,
        status,
        cancelAtPeriodEnd: false,
        couponCampaignId: draft.couponCampaignId,
        discountedCyclesRemaining:
          draft.discountedBillingCycles,
        source: 'customer',
      }], { session })
      return created[0]._id
    },

    async updateSubscriptionStatus(input) {
      const update = await Subscription.updateOne(
        {
          _id: input.subscription.id,
          userId: input.subscription.userId,
          providerMode: input.subscription.providerMode,
          razorpaySubscriptionId:
            input.subscription.razorpaySubscriptionId,
          checkoutIntentId:
            input.subscription.checkoutIntentId,
          planChangeRequestId:
            input.subscription.planChangeRequestId,
          replacesSubscriptionId:
            input.subscription.replacesSubscriptionId,
          leaseLane: input.subscription.leaseLane,
          requestedStartAt:
            input.subscription.requestedStartAt,
          authorizationExpiresAt:
            input.subscription.authorizationExpiresAt,
          status: input.subscription.status,
          ...subscriptionPeriodFilter(input.subscription),
        },
        { $set: { status: input.status } },
        { session, runValidators: true },
      )
      return update.matchedCount === 1 &&
        update.modifiedCount === 1
    },

    async updateIntentStatus(input) {
      const update = await CheckoutIntent.updateOne(
        {
          _id: input.intent.id,
          userId: input.intent.userId,
          providerMode: input.intent.providerMode,
          razorpaySubscriptionId:
            input.intent.razorpaySubscriptionId,
          purpose: input.intent.purpose,
          planChangeRequestId:
            input.intent.planChangeRequestId,
          leaseLane: input.intent.leaseLane,
          requestedStartAt: input.intent.requestedStartAt,
          authorizationExpiresAt:
            input.intent.authorizationExpiresAt,
          status: input.intent.status,
        },
        { $set: { status: input.status } },
        { session, runValidators: true },
      )
      return update.matchedCount === 1 &&
        update.modifiedCount === 1
    },

    async recordTerminalLease(input) {
      const { lease, observedAt } = input
      if (lease.status === 'released') {
        const update = await ConsumerSubscriptionLease.updateOne(
          {
            _id: lease.id,
            userId: lease.userId,
            providerMode: lease.providerMode,
            lane: lease.lane,
            ownerCheckoutIntentId:
              lease.ownerCheckoutIntentId,
            razorpaySubscriptionId:
              lease.razorpaySubscriptionId,
            status: 'released',
            remoteTerminalVerifiedAt: { $exists: false },
          },
          { $set: { remoteTerminalVerifiedAt: observedAt } },
          { session, runValidators: true },
        )
        return update.matchedCount === 1 &&
          update.modifiedCount === 1
      }

      const update = await ConsumerSubscriptionLease.updateOne(
        {
          _id: lease.id,
          userId: lease.userId,
          providerMode: lease.providerMode,
          lane: lease.lane,
          ownerCheckoutIntentId: lease.ownerCheckoutIntentId,
          razorpaySubscriptionId: lease.razorpaySubscriptionId,
          status: lease.status,
        },
        {
          $set: {
            status: 'released',
            remoteTerminalVerifiedAt: observedAt,
            releasedAt: observedAt,
            releaseReason: 'remote_terminal_verified',
          },
          $unset: { releasedBy: 1 },
        },
        { session, runValidators: true },
      )
      return update.matchedCount === 1 &&
        update.modifiedCount === 1
    },

    async releaseCouponReservation(input) {
      const result = await releaseCouponReservationInSession(
        {
          providerMode: input.providerMode,
          campaignId: input.campaignId.toString(),
          userId: input.userId.toString(),
          checkoutIntentId: input.checkoutIntentId.toString(),
          terminalAt: input.terminalAt,
          evidence: {
            reason: input.reason,
            source: input.evidenceSource,
            evidenceKey: input.evidenceKey,
            observedAt: input.terminalAt,
          },
        },
        session,
      )
      return result.outcome === 'released' ||
        result.outcome === 'review'
    },

    async appendSubscriptionStateCommercialAnalytics(
      requestedProducer,
      evidence,
    ) {
      if (!producer || requestedProducer !== producer) {
        throw failure(
          'persistence_conflict',
          'Subscription state analytics producer is not transaction-bound',
        )
      }
      await producer.appendSubscriptionStateTransitionInSession(
        evidence,
        session,
      )
    },

    async appendSubscriptionDunningObservation(
      requestedProducer,
      evidence,
    ) {
      if (
        !dunningProducer ||
        requestedProducer !== dunningProducer
      ) {
        throw failure(
          'persistence_conflict',
          'Subscription dunning producer is not transaction-bound',
        )
      }
      await dunningProducer
        .appendSubscriptionDunningObservationInSession(
          evidence,
          session,
        )
    },
  }
}

function duplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (
      ('code' in error && error.code === 11000) ||
      ('cause' in error && duplicateKeyError(error.cause))
    ),
  )
}

export const mongoSubscriptionStatePersistenceStore:
SubscriptionStatePersistenceStore = {
  async loadOriginalIntent(input) {
    await connectDB()
    return loadMongoIntent(input)
  },

  async runTransaction(work, producer, dunningProducer) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await mongoose.startSession()
      let result: Awaited<ReturnType<typeof work>> | undefined
      let completed = false
      try {
        await session.withTransaction(async () => {
          result = await work(mongoTransaction(
            session,
            producer,
            dunningProducer,
          ))
          completed = true
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        })
      } catch (error) {
        if (attempt === 0 && duplicateKeyError(error)) continue
        throw error
      } finally {
        await session.endSession()
      }
      if (!completed) {
        throw failure(
          'persistence_conflict',
          'Subscription state transaction returned no result',
        )
      }
      return result as Awaited<ReturnType<typeof work>>
    }
    throw failure(
      'persistence_conflict',
      'Subscription state duplicate recovery was exhausted',
    )
  },
}

async function persistValidatedSubscriptionState(
  input: Pick<
    SubscriptionStateEffectInput,
    | 'providerMode'
    | 'providerObservedAt'
    | 'razorpaySubscriptionId'
    | 'localContext'
  >,
  normalize: () => {
    subscription: RazorpaySubscriptionDto
    payment?: RazorpayPaymentDto
  },
  dependencies: SubscriptionStatePersistenceDependencies,
  persistenceMessage: string,
  observationEvidence: SubscriptionStateObservationEvidence,
): Promise<SubscriptionStatePersistenceResult> {
  const observedAt = input.providerObservedAt
  if (!validDate(observedAt)) {
    throw failure(
      'invalid_input',
      'Subscription state observation time is invalid',
    )
  }
  const entities = normalize()
  const checkout = input.localContext.checkout
  if (!checkout) {
    throw failure(
      'local_context_missing',
      'Customer subscription state requires checkout context',
    )
  }
  const store =
    dependencies.store ?? mongoSubscriptionStatePersistenceStore
  const resolver =
    dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver

  let intent: SubscriptionStateCheckoutIntent | null
  try {
    intent = await store.loadOriginalIntent({
      providerMode: input.providerMode,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
    })
  } catch (error) {
    throw failure(
      'persistence_conflict',
      'Original subscription checkout could not be loaded',
      error,
    )
  }
  if (!intent) {
    throw failure(
      'intent_not_found',
      'Original subscription checkout intent was not found',
    )
  }
  assertIntentShape(intent)
  assertCheckoutContext(checkout, intent, {
    providerMode: input.providerMode,
    razorpaySubscriptionId: input.razorpaySubscriptionId,
    subscription: entities.subscription,
  })
  assertSubscriptionContext(
    input.localContext.subscription,
    checkout,
    intent,
    entities.subscription,
  )

  let terms: ResolvedSubscriptionCommercialTerms | null
  try {
    terms = await resolver.resolve(intent)
  } catch (error) {
    if (error instanceof SubscriptionStatePersistenceError) throw error
    throw failure(
      'catalog_conflict',
      'Immutable subscription terms could not be resolved',
      error,
    )
  }
  if (!terms) {
    throw failure(
      'catalog_conflict',
      'Immutable subscription terms were not found',
    )
  }
  const binding = commercialBinding(
    intent,
    terms,
    entities.subscription,
  )
  const draft: SubscriptionStateDraft = {
    ...binding,
    checkoutIntentId: intent.id,
    purpose: intent.purpose,
    planChangeRequestId: intent.planChangeRequestId,
    replacesSubscriptionId: intent.replacesSubscriptionId,
    leaseLane: intent.leaseLane,
    requestedStartAt: intent.requestedStartAt,
    authorizationExpiresAt: intent.authorizationExpiresAt,
    userId: intent.userId,
    providerMode: input.providerMode,
    receipt: intent.receipt,
    intentCreatedAt: intent.createdAt,
    listPricePaise: intent.quote.listPricePaise,
    discountPaise: intent.quote.discountPaise,
    payablePaise: intent.quote.payablePaise,
    renewalPricePaise: intent.quote.renewalPricePaise,
    razorpaySubscriptionId: entities.subscription.id,
    remoteStatus: entities.subscription.status,
    subscriptionSnapshot: entities.subscription,
    paymentSnapshot: entities.payment,
    expectedSubscriptionContextId:
      input.localContext.subscription?._id,
  }

  try {
    return await store.runTransaction(
      (transaction) => persistTransactionState(
        transaction,
        draft,
        observedAt,
        observationEvidence,
        dependencies.commercialAnalyticsProducer,
        dependencies.dunningProducer,
      ),
      dependencies.commercialAnalyticsProducer,
      dependencies.dunningProducer,
    )
  } catch (error) {
    if (error instanceof SubscriptionStatePersistenceError) throw error
    throw failure('persistence_conflict', persistenceMessage, error)
  }
}

/**
 * Applies server-fetched non-charge subscription lifecycle state. This
 * function never treats activation/authentication, provider current-period
 * timestamps, or an attached payment as paid entitlement evidence. Only the
 * local current-period tuple written atomically by paid-cycle fulfillment can
 * make a fetched active subscription locally active.
 */
export async function persistSubscriptionState(
  input: SubscriptionStateEffectInput,
  dependencies: SubscriptionStatePersistenceDependencies = {},
): Promise<SubscriptionStatePersistenceResult> {
  return persistValidatedSubscriptionState(
    input,
    () => assertEffectEnvelope(input),
    dependencies,
    'Subscription lifecycle state could not be persisted coherently',
    {
      source: 'signed_webhook',
      key: `${input.providerMode}:webhook:${input.inboxEventId}`,
      webhookInboxEventId: input.inboxEventId,
      webhookEventType: input.eventType,
    },
  )
}

/**
 * Exact provider observation used by reconciliation. It intentionally omits
 * webhook event and inbox fields because no webhook is being fabricated.
 */
export type SubscriptionProviderObservationInput = Omit<
  SubscriptionStateEffectInput,
  'inboxEventId' | 'eventType'
>

function assertSubscriptionProviderObservation(
  input: SubscriptionProviderObservationInput,
): {
  subscription: RazorpaySubscriptionDto
  payment?: RazorpayPaymentDto
} {
  let subscription: RazorpaySubscriptionDto
  let payment: RazorpayPaymentDto | undefined
  try {
    subscription = RazorpaySubscriptionDtoSchema.parse(
      input.subscription,
    )
    payment = input.payment
      ? RazorpayPaymentDtoSchema.parse(input.payment)
      : undefined
  } catch (error) {
    throw failure(
      'invalid_input',
      'Normalized Razorpay state observation is invalid',
      error,
    )
  }

  if (
    subscription.providerMode !== input.providerMode ||
    subscription.id !== input.razorpaySubscriptionId
  ) {
    throw failure(
      'reference_conflict',
      'Fetched subscription does not match the provider observation',
    )
  }
  const hasCurrentStart =
    subscription.currentStartEpochSeconds !== undefined
  const hasCurrentEnd =
    subscription.currentEndEpochSeconds !== undefined
  if (
    hasCurrentStart !== hasCurrentEnd ||
    (
      hasCurrentStart &&
      hasCurrentEnd &&
      (subscription.currentEndEpochSeconds as number) <=
        (subscription.currentStartEpochSeconds as number)
    ) ||
    subscription.paidCount > subscription.totalCount ||
    subscription.remainingCount > subscription.totalCount
  ) {
    throw failure(
      'reference_conflict',
      'Fetched subscription lifecycle counters are inconsistent',
    )
  }

  const hasPaymentReferences = Boolean(
    input.razorpayPaymentId ||
    input.razorpayOrderId ||
    input.razorpayInvoiceId,
  )
  if (!payment) {
    if (hasPaymentReferences) {
      throw failure(
        'reference_conflict',
        'Payment references lack a fetched normalized payment',
      )
    }
    return { subscription }
  }
  if (
    input.razorpayPaymentId !== payment.id ||
    (
      input.razorpayOrderId !== undefined &&
      input.razorpayOrderId !== payment.orderId
    ) ||
    (
      input.razorpayInvoiceId !== undefined &&
      input.razorpayInvoiceId !== payment.invoiceId
    ) ||
    payment.providerMode !== input.providerMode ||
    payment.subscriptionId !== subscription.id
  ) {
    throw failure(
      'reference_conflict',
      'Fetched state-observation payment references are inconsistent',
    )
  }
  return { subscription, payment }
}

/**
 * Persists a lifecycle state found by an exact provider read. The same
 * commercial, lease, paid-period, and transaction invariants as the webhook
 * path apply, without creating a webhook row or fake inbox identifier.
 */
export async function persistSubscriptionProviderObservation(
  input: SubscriptionProviderObservationInput,
  dependencies: SubscriptionStatePersistenceDependencies = {},
): Promise<SubscriptionStatePersistenceResult> {
  return persistValidatedSubscriptionState(
    input,
    () => assertSubscriptionProviderObservation(input),
    dependencies,
    'Subscription lifecycle observation could not be persisted coherently',
    {
      source: 'provider_fetch',
      key:
        `${input.providerMode}:subscription:` +
        `${input.razorpaySubscriptionId}:` +
        `${input.subscription.status}`,
      webhookInboxEventId: null,
      webhookEventType: null,
    },
  )
}
