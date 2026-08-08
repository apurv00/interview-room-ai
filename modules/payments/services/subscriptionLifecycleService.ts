import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import { CURRENT_PLAN_VOCABULARY_VERSION } from '@shared/services/planConfig'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import { CheckoutIntent } from '../models/CheckoutIntent'
import {
  ConsumerSubscriptionLease,
  type ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import {
  PlanChangeRequest,
  classifyPlanChangeControlLineage,
  exactPlanChangeControlFilter,
  type IPlanChangeRequest,
  type PlanChangeAdminControlV1,
  type PlanChangeRequestOperation,
  type PlanChangeRequestSource,
  type PlanChangeRequestStatus,
} from '../models/PlanChangeRequest'
import {
  Subscription,
  type ISubscription,
  type SubscriptionStatus,
} from '../models/Subscription'
import {
  createRazorpayClientFactory,
  createRazorpaySubscriptionCancellationClientFactory,
  type RazorpayClientFactory,
  type RazorpaySubscriptionCancellationClientFactory,
} from '../providers/razorpayClientFactory'
import {
  loadRazorpayApiCredentials,
} from '../providers/razorpayEnvironment'
import {
  verifyRazorpaySubscriptionCheckoutSignature,
} from '../providers/razorpaySignature'
import {
  RazorpayPaymentDtoSchema,
  RazorpaySubscriptionDtoSchema,
  type RazorpayPaymentDto,
  type RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import {
  commitCouponReservationAuthorizationInSession,
} from './couponReservationService'
import {
  classifyFutureSubscriptionAuthorizationEvidence,
  type FutureSubscriptionAuthorizationDecision,
  type FutureSubscriptionAuthorizationExpectation,
} from './futureSubscriptionAuthorizationClassifier'
import {
  transitionPlanChangeStatus,
} from './planChangeTransitionKernel'
import {
  createFutureSubscriptionCheckout,
  resolveSubscriptionCheckoutSaleContext,
  type FutureSubscriptionCheckoutResult,
  type SubscriptionCheckoutSaleContext,
} from './subscriptionCheckoutService'
import {
  resolveCustomerBillingQuote,
} from './customerBillingQuoteService'
import {
  verifyCapturedCheckout,
  type CapturedCheckoutVerificationResult,
} from './capturedCheckoutVerificationService'
import {
  CURRENT_PAYMENT_CODE_READINESS,
} from './paymentRuntimeGate'
import {
  assertSubscriptionCommercialIntent,
  assertSubscriptionLifecycleIntent,
  mongoSubscriptionCycleCommercialResolver,
  requireSubscriptionCommercialTerms,
  type OriginalSubscriptionCheckoutIntent,
  type SubscriptionCycleCommercialResolver,
} from './subscriptionCycleFulfillmentService'
import {
  CustomerBillingIdempotencyKeySchema,
} from '../validators/customerBilling'
import { CouponCodeSchema } from '../validators/coupon'
import {
  persistSubscriptionProviderObservation,
  type SubscriptionProviderObservationInput,
  type SubscriptionStatePersistenceResult,
} from './subscriptionStatePersistenceService'
import type {
  TrustedSubscriptionWebhookCheckout,
  TrustedWebhookSubscription,
} from './webhookDomainDispatchService'

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]+$/
const PLAN_ID_PATTERN = /^plan_[A-Za-z0-9]+$/
const RECOVERY_DELAY_MS = 5 * 60 * 1_000
export const PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY = true as const
export const PR6_CUSTOMER_SUBSCRIPTION_CANCELLATION_READY =
  true as const
export const PR6_CUSTOMER_SCHEDULED_CHANGE_CANCELLATION_READY =
  true as const
const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export const SUBSCRIPTION_LIFECYCLE_ERROR_CODES = [
  'invalid_request',
  'sale_blocked',
  'not_found',
  'signature_invalid',
  'lifecycle_conflict',
  'commercial_conflict',
  'provider_unavailable',
  'persistence_conflict',
  'review_required',
] as const
export type SubscriptionLifecycleErrorCode =
  (typeof SUBSCRIPTION_LIFECYCLE_ERROR_CODES)[number]

export class SubscriptionLifecycleError extends Error {
  constructor(
    readonly code: SubscriptionLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionLifecycleError'
  }
}

export interface FutureSubscriptionAuthorizationVerificationInput {
  userId: string
  intentId: string
  razorpayPaymentId: string
  signature: string
}

export interface TrustedFutureSubscriptionAuthorizationObservationInput {
  userId: string
  intentId: string
  razorpayPaymentId: string
  payment: RazorpayPaymentDto
  subscription: RazorpaySubscriptionDto
}

export interface FutureSubscriptionAuthorizationVerificationResult {
  intentId: string
  planChangeRequestId: string
  status:
    | 'authorization_pending'
    | 'authorized'
    | 'scheduled'
    | 'reconciling'
    | 'manual_review'
  pollAfterMs?: number
  reused: boolean
}

export type TrustedSubscriptionCheckoutVerificationResult =
  | {
      flow: 'acquisition'
      result: CapturedCheckoutVerificationResult
    }
  | {
      flow: 'future_authorization'
      result: FutureSubscriptionAuthorizationVerificationResult
    }

export interface TrustedSubscriptionCheckoutVerificationDependencies {
  loadPurpose?: (input: {
    userId: string
    intentId: string
  }) => Promise<'acquisition' | 'replacement' | 'resubscribe' | null>
  verifyAcquisition?: typeof verifyCapturedCheckout
  verifyFuture?: typeof verifyFutureSubscriptionAuthorization
}

interface FutureAuthorizationCheckoutRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'subscription'
  providerMode: ProviderMode
  purpose: 'replacement' | 'resubscribe'
  planChangeRequestId: mongoose.Types.ObjectId
  leaseLane: ConsumerSubscriptionLeaseLane
  requestedStartAt: Date
  authorizationExpiresAt: Date
  planKey: 'plus' | 'pro'
  catalogVersion: string
  status:
    | 'remote_created'
    | 'checkout_opened'
    | 'authorization_pending'
    | 'review'
  razorpaySubscriptionId: string
  receipt: string
  createdAt: Date
  quoteSnapshot: {
    currency: 'INR'
    listPricePaise: number
    discountPaise: number
    payablePaise: number
    renewalPricePaise: number
    subscriptionTotalCount: number
    discountedBillingCycles?: number
    couponCampaignId?: mongoose.Types.ObjectId
    couponCampaignRevision?: number
  }
}

interface FutureAuthorizationPlanChangeRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  operation: 'tier_change' | 'resubscribe'
  fromPlanKey: 'plus' | 'pro'
  toPlanKey: 'plus' | 'pro'
  targetCatalogVersion: string
  requestedAt: Date
  requestedEffectiveAt: Date
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  fromSubscriptionId: mongoose.Types.ObjectId
  toSubscriptionId?: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId: string
  activeFenceKey: string
  status: PlanChangeRequestStatus
  authorizationExpiresAt: Date
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAt?: Date
}

interface FutureAuthorizationCurrentSubscriptionRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  status: SubscriptionStatus
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  leaseLane: ConsumerSubscriptionLeaseLane
}

interface FutureAuthorizationLeaseRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  lane: ConsumerSubscriptionLeaseLane
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId: string
  status: 'held' | 'release_pending' | 'released' | 'review'
}

export interface TrustedFutureAuthorizationContext {
  intent: FutureAuthorizationCheckoutRow
  planChange: FutureAuthorizationPlanChangeRow
  currentSubscription: FutureAuthorizationCurrentSubscriptionRow
  lease: FutureAuthorizationLeaseRow
}

export interface FutureSubscriptionAuthorizationDependencies {
  loadContext?: (input: {
    userId: string
    intentId: string
  }) => Promise<TrustedFutureAuthorizationContext | null>
  loadKeySecret?: (providerMode: ProviderMode) => string
  clientFactory?: RazorpayClientFactory
  commercialResolver?: SubscriptionCycleCommercialResolver
  commitAcceptedAuthorization?: (input: {
    context: TrustedFutureAuthorizationContext
    payment: RazorpayPaymentDto
    subscription: RazorpaySubscriptionDto
    authenticatedAt: Date
  }) => Promise<{
    reused: boolean
    status: 'old_cancellation_pending' | 'scheduled' | 'review'
  }>
  markReview?: (input: {
    context: TrustedFutureAuthorizationContext
    reason: string
    observedAt: Date
    payment?: RazorpayPaymentDto
    subscription?: RazorpaySubscriptionDto
  }) => Promise<void>
  submitOldCancellation?: (input: {
    planChangeRequestId: string
    observedAt: Date
  }) => Promise<PeriodEndCancellationSubmissionResult>
  now?: () => Date
}

export interface PeriodEndCancellationSubmissionResult {
  planChangeRequestId: string
  status: 'scheduled' | 'reconciling'
  effectiveAt: string
  reused: boolean
  pollAfterMs?: number
}

interface CancellationRequestRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  operation: 'tier_change' | 'period_end_cancel'
  toPlanKey: 'free' | 'plus' | 'pro'
  requestedAt: Date
  requestedEffectiveAt: Date
  providerMode: ProviderMode
  fromSubscriptionId: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId: string
  status: PlanChangeRequestStatus
  oldCancellationAcceptedAt?: Date
  oldCancellationEffectiveAt?: Date
}

interface CancellationSubscriptionRow {
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
  status: SubscriptionStatus
  currentPeriodKey: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
}

export interface PeriodEndCancellationDependencies {
  cancellationClientFactory?: RazorpaySubscriptionCancellationClientFactory
  loadCancellationContext?: (input: {
    planChangeRequestId: string
  }) => Promise<{
    request: CancellationRequestRow
    subscription: CancellationSubscriptionRow
  } | null>
  commitCancellationAccepted?: (input: {
    request: CancellationRequestRow
    subscription: CancellationSubscriptionRow
    provider: RazorpaySubscriptionDto
    observedAt: Date
  }) => Promise<{ reused: boolean }>
  markCancellationUncertain?: (input: {
    request: CancellationRequestRow
    observedAt: Date
    reason: string
  }) => Promise<void>
}

export interface CustomerFuturePlanChangeInput {
  userId: string
  idempotencyKey: string
  operation: 'tier_change' | 'resubscribe'
  targetPlanKey?: 'plus' | 'pro'
  manualCouponCode?: string
}

export interface CustomerFuturePlanChangeResult {
  planChangeRequestId: string
  effectiveAt: string
  checkout: FutureSubscriptionCheckoutResult
  reused: boolean
}

interface CurrentLifecycleSubscription {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  leaseLane: ConsumerSubscriptionLeaseLane
  status: 'active'
  currentPeriodKey: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
}

interface CurrentCancellationSubscription {
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
  leaseLane: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  status: 'active' | 'authenticated'
  currentPeriodKey: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
}

interface FutureCommercialTarget {
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  reservationTtlHours: number
}

interface PersistedFuturePlanChange {
  planChangeRequestId: string
  checkoutIntentId: string
  effectiveAt: Date
  reused: boolean
}

export interface CustomerFuturePlanChangeDependencies {
  lifecycleReady?: boolean
  remoteCreationReady?: boolean
  resolveSaleContext?: (
    userId: string,
  ) => Promise<SubscriptionCheckoutSaleContext>
  now?: () => Date
  loadCurrentSubscription?: (input: {
    userId: string
    now: Date
  }) => Promise<CurrentLifecycleSubscription | null>
  resolveCommercialTarget?: (input: {
    userId: string
    targetPlanKey: 'plus' | 'pro'
    manualCouponCode?: string
  }) => Promise<FutureCommercialTarget>
  persistPlanChange?: (input: {
    userId: string
    idempotencyKey: string
    selectionHash: string
    operation: 'tier_change' | 'resubscribe'
    current: CurrentLifecycleSubscription
    target: FutureCommercialTarget
    requestedAt: Date
  }) => Promise<PersistedFuturePlanChange>
  createFutureCheckout?: typeof createFutureSubscriptionCheckout
}

export interface CustomerPeriodEndCancellationDependencies {
  cancellationReady?: boolean
  now?: () => Date
  loadCurrentSubscription?: (input: {
    userId: string
    now: Date
  }) => Promise<CurrentCancellationSubscription | null>
  persistCancellationRequest?: (input: {
    userId: string
    idempotencyKey: string
    selectionHash: string
    current: CurrentCancellationSubscription
    requestedAt: Date
  }) => Promise<PersistedFuturePlanChange>
  submitCancellation?: typeof submitOldSubscriptionPeriodEndCancellation
}

function normalizeFuturePlanChangeInput(
  input: CustomerFuturePlanChangeInput,
): CustomerFuturePlanChangeInput & {
  idempotencyKey: string
  manualCouponCode?: string
} {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    (
      input.operation !== 'tier_change' &&
      input.operation !== 'resubscribe'
    ) ||
    (
      input.targetPlanKey !== undefined &&
      input.targetPlanKey !== 'plus' &&
      input.targetPlanKey !== 'pro'
    ) ||
    (
      input.operation === 'tier_change' &&
      input.targetPlanKey === undefined
    ) ||
    (
      input.operation === 'resubscribe' &&
      input.targetPlanKey !== undefined
    )
  ) {
    throw failure('invalid_request', 'Plan change request is invalid')
  }
  const idempotencyKey = CustomerBillingIdempotencyKeySchema.parse(
    input.idempotencyKey,
  )
  const manualCouponCode = input.manualCouponCode === undefined
    ? undefined
    : CouponCodeSchema.parse(input.manualCouponCode)
  return {
    ...input,
    idempotencyKey,
    ...(manualCouponCode ? { manualCouponCode } : {}),
  }
}

function exactCurrentLifecycleSubscription(
  current: CurrentLifecycleSubscription,
  userId: mongoose.Types.ObjectId,
  now: Date,
): boolean {
  return (
    current._id instanceof mongoose.Types.ObjectId &&
    current.userId.equals(userId) &&
    (current.providerMode === 'test' || current.providerMode === 'live') &&
    (current.planKey === 'plus' || current.planKey === 'pro') &&
    current.catalogVersion.trim().length > 0 &&
    PLAN_ID_PATTERN.test(current.razorpayPlanId) &&
    SUBSCRIPTION_ID_PATTERN.test(current.razorpaySubscriptionId) &&
    (current.leaseLane === 'a' || current.leaseLane === 'b') &&
    current.status === 'active' &&
    typeof current.currentPeriodKey === 'string' &&
    current.currentPeriodKey.trim().length > 0 &&
    exactEpochSecond(current.currentPeriodStart) &&
    exactEpochSecond(current.currentPeriodEnd) &&
    current.currentPeriodStart < current.currentPeriodEnd &&
    current.currentPeriodStart <= now &&
    current.currentPeriodEnd > now
  )
}

function couponUpfrontCancellationLineage(
  current: {
    checkoutIntentId?: mongoose.Types.ObjectId
    planChangeRequestId?: mongoose.Types.ObjectId
    replacesSubscriptionId?: mongoose.Types.ObjectId
    leaseLane?: ConsumerSubscriptionLeaseLane
    requestedStartAt?: Date
    currentPeriodEnd: Date
    couponCampaignId?: mongoose.Types.ObjectId
    discountedCyclesRemaining?: number
  },
): boolean {
  return (
    current.checkoutIntentId instanceof mongoose.Types.ObjectId &&
    current.planChangeRequestId === undefined &&
    current.replacesSubscriptionId === undefined &&
    current.leaseLane === 'a' &&
    exactEpochSecond(current.requestedStartAt) &&
    current.requestedStartAt.getTime() ===
      current.currentPeriodEnd.getTime() &&
    current.couponCampaignId instanceof mongoose.Types.ObjectId &&
    current.discountedCyclesRemaining === 0
  )
}

function couponUpfrontCheckoutFilter(
  current: CurrentCancellationSubscription,
  userId: mongoose.Types.ObjectId,
): Record<string, unknown> | null {
  if (!couponUpfrontCancellationLineage(current)) return null
  return {
    _id: current.checkoutIntentId,
    userId,
    kind: 'subscription',
    providerMode: current.providerMode,
    purpose: 'acquisition',
    planChangeRequestId: { $exists: false },
    leaseLane: 'a',
    requestedStartAt: current.currentPeriodEnd,
    planKey: current.planKey,
    catalogVersion: current.catalogVersion,
    status: 'fulfilled',
    razorpaySubscriptionId: current.razorpaySubscriptionId,
    'quoteSnapshot.couponCampaignId': current.couponCampaignId,
    'quoteSnapshot.discountedBillingCycles': 1,
    'quoteSnapshot.discountPaise': { $gt: 0 },
    'quoteSnapshot.payablePaise': { $gt: 0 },
  }
}

function exactCurrentCancellationSubscription(
  current: CurrentCancellationSubscription,
  userId: mongoose.Types.ObjectId,
  now: Date,
): boolean {
  return (
    current._id instanceof mongoose.Types.ObjectId &&
    current.userId.equals(userId) &&
    (current.providerMode === 'test' || current.providerMode === 'live') &&
    (current.planKey === 'plus' || current.planKey === 'pro') &&
    current.catalogVersion.trim().length > 0 &&
    PLAN_ID_PATTERN.test(current.razorpayPlanId) &&
    SUBSCRIPTION_ID_PATTERN.test(current.razorpaySubscriptionId) &&
    (current.leaseLane === 'a' || current.leaseLane === 'b') &&
    (
      current.status === 'active' ||
      (
        current.status === 'authenticated' &&
        couponUpfrontCancellationLineage(current)
      )
    ) &&
    typeof current.currentPeriodKey === 'string' &&
    current.currentPeriodKey.trim().length > 0 &&
    exactEpochSecond(current.currentPeriodStart) &&
    exactEpochSecond(current.currentPeriodEnd) &&
    current.currentPeriodStart < current.currentPeriodEnd &&
    current.currentPeriodStart <= now &&
    current.currentPeriodEnd > now &&
    typeof current.cancelAtPeriodEnd === 'boolean'
  )
}

async function defaultLoadCurrentCancellationSubscription(input: {
  userId: string
  now: Date
}): Promise<CurrentCancellationSubscription | null> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const [user, subscriptions] = await Promise.all([
    User.findById(userId).select([
      'plan',
      'planVocabularyVersion',
      'planExpiresAt',
      'entitlementSource',
      'usagePeriodKey',
    ].join(' ')).lean<{
      plan: string
      planVocabularyVersion?: number
      planExpiresAt?: Date
      entitlementSource?: string
      usagePeriodKey?: string
    }>(),
    Subscription.find({
      userId,
      status: { $in: ['active', 'authenticated'] },
      currentPeriodStart: { $lte: input.now },
      currentPeriodEnd: { $gt: input.now },
    }).select([
      '_id',
      'userId',
      'providerMode',
      'planKey',
      'catalogVersion',
      'razorpayPlanId',
      'razorpaySubscriptionId',
      'checkoutIntentId',
      'planChangeRequestId',
      'replacesSubscriptionId',
      'leaseLane',
      'requestedStartAt',
      'status',
      'currentPeriodKey',
      'currentPeriodStart',
      'currentPeriodEnd',
      'cancelAtPeriodEnd',
      'couponCampaignId',
      'discountedCyclesRemaining',
    ].join(' ')).limit(2).lean<CurrentCancellationSubscription[]>(),
  ])
  if (subscriptions.length !== 1) return null
  const current = subscriptions[0]
  if (
    !user ||
    !exactCurrentCancellationSubscription(current, userId, input.now) ||
    user.plan !== current.planKey ||
    user.planVocabularyVersion !== CURRENT_PLAN_VOCABULARY_VERSION ||
    user.entitlementSource !== 'subscription' ||
    user.usagePeriodKey !== current.currentPeriodKey ||
    !validDate(user.planExpiresAt) ||
    user.planExpiresAt.getTime() !== current.currentPeriodEnd.getTime()
  ) {
    return null
  }
  if (current.status === 'authenticated') {
    const checkoutFilter = couponUpfrontCheckoutFilter(current, userId)
    if (
      !checkoutFilter ||
      !(await CheckoutIntent.exists(checkoutFilter))
    ) {
      return null
    }
  }
  return current
}

async function defaultLoadCurrentLifecycleSubscription(input: {
  userId: string
  now: Date
}): Promise<CurrentLifecycleSubscription | null> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const [user, subscriptions] = await Promise.all([
    User.findById(userId).select([
      'plan',
      'planVocabularyVersion',
      'planExpiresAt',
      'entitlementSource',
      'usagePeriodKey',
    ].join(' ')).lean<{
      plan: string
      planVocabularyVersion?: number
      planExpiresAt?: Date
      entitlementSource?: string
      usagePeriodKey?: string
    }>(),
    Subscription.find({
      userId,
      status: 'active',
      currentPeriodStart: { $lte: input.now },
      currentPeriodEnd: { $gt: input.now },
    }).select([
      '_id',
      'userId',
      'providerMode',
      'planKey',
      'catalogVersion',
      'razorpayPlanId',
      'razorpaySubscriptionId',
      'leaseLane',
      'status',
      'currentPeriodKey',
      'currentPeriodStart',
      'currentPeriodEnd',
      'cancelAtPeriodEnd',
    ].join(' ')).limit(2).lean<CurrentLifecycleSubscription[]>(),
  ])
  if (subscriptions.length !== 1) return null
  const current = subscriptions[0]
  if (
    !user ||
    !exactCurrentLifecycleSubscription(current, userId, input.now) ||
    user.plan !== current.planKey ||
    user.planVocabularyVersion !== CURRENT_PLAN_VOCABULARY_VERSION ||
    user.entitlementSource !== 'subscription' ||
    user.usagePeriodKey !== current.currentPeriodKey ||
    !validDate(user.planExpiresAt) ||
    user.planExpiresAt.getTime() !== current.currentPeriodEnd.getTime()
  ) {
    return null
  }
  return current
}

async function defaultResolveFutureCommercialTarget(input: {
  userId: string
  targetPlanKey: 'plus' | 'pro'
  manualCouponCode?: string
}): Promise<FutureCommercialTarget> {
  const resolved = await resolveCustomerBillingQuote({
    userId: input.userId,
    request: {
      planKey: input.targetPlanKey,
      surface: 'checkout',
      manualCouponCode: input.manualCouponCode,
    },
  })
  const providerMode = resolved.providerMode
  const plan = resolved.catalog.content.plans[input.targetPlanKey]
  const razorpayPlanId = providerMode
    ? plan.razorpayPlanIdByMode?.[providerMode]
    : undefined
  const reservationTtlHours =
    resolved.selectedCandidate?.terms.reservationTtlHours ?? 24
  if (
    !providerMode ||
    resolved.quote.planKey !== input.targetPlanKey ||
    resolved.quote.catalogVersion !== resolved.catalog.version ||
    resolved.catalog.status !== 'published' ||
    typeof razorpayPlanId !== 'string' ||
    !PLAN_ID_PATTERN.test(razorpayPlanId) ||
    !Number.isSafeInteger(reservationTtlHours) ||
    reservationTtlHours < 1 ||
    reservationTtlHours > 168
  ) {
    throw failure(
      'commercial_conflict',
      'Published future subscription terms are unavailable',
    )
  }
  return {
    providerMode,
    planKey: input.targetPlanKey,
    catalogVersion: resolved.catalog.version,
    razorpayPlanId,
    reservationTtlHours,
  }
}

function samePersistedFuturePlanChange(
  request: IPlanChangeRequest,
  input: {
    idempotencyKey: string
    selectionHash: string
    operation: 'tier_change' | 'resubscribe'
    current: CurrentLifecycleSubscription
    target: FutureCommercialTarget
  },
): boolean {
  return (
    request.source === 'customer' &&
    request.operation === input.operation &&
    request.idempotencyKey === input.idempotencyKey &&
    request.checkoutSelectionHash === input.selectionHash &&
    request.fromPlanKey === input.current.planKey &&
    request.toPlanKey === input.target.planKey &&
    request.targetCatalogVersion === input.target.catalogVersion &&
    request.providerMode === input.current.providerMode &&
    sameObjectId(request.fromSubscriptionId, input.current._id) &&
    request.fromRazorpaySubscriptionId ===
      input.current.razorpaySubscriptionId &&
    request.targetRazorpayPlanId === input.target.razorpayPlanId &&
    request.requestedEffectiveAt.getTime() ===
      input.current.currentPeriodEnd.getTime() &&
    request.checkoutIntentId instanceof mongoose.Types.ObjectId &&
    validDate(request.authorizationExpiresAt)
  )
}

async function persistFuturePlanChangeMongo(input: {
  userId: string
  idempotencyKey: string
  selectionHash: string
  operation: 'tier_change' | 'resubscribe'
  current: CurrentLifecycleSubscription
  target: FutureCommercialTarget
  requestedAt: Date
}): Promise<PersistedFuturePlanChange> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const requestId = new mongoose.Types.ObjectId()
  const checkoutIntentId = new mongoose.Types.ObjectId()
  const session = await mongoose.startSession()
  let result: PersistedFuturePlanChange | undefined
  try {
    await session.withTransaction(async () => {
      const existing = await PlanChangeRequest.findOne({
        userId,
        source: 'customer',
        idempotencyKey: input.idempotencyKey,
      }).session(session)
      if (existing) {
        if (!samePersistedFuturePlanChange(existing, input)) {
          throw failure(
            'lifecycle_conflict',
            'Idempotency key belongs to a different plan change',
          )
        }
        result = {
          planChangeRequestId: existing._id.toHexString(),
          checkoutIntentId: existing.checkoutIntentId!.toHexString(),
          effectiveAt: existing.requestedEffectiveAt,
          reused: true,
        }
        return
      }

      const current = await Subscription.findOne({
        _id: input.current._id,
        userId,
        providerMode: input.current.providerMode,
        razorpaySubscriptionId:
          input.current.razorpaySubscriptionId,
        status: 'active',
        currentPeriodKey: input.current.currentPeriodKey,
        currentPeriodStart: input.current.currentPeriodStart,
        currentPeriodEnd: input.current.currentPeriodEnd,
        cancelAtPeriodEnd: input.current.cancelAtPeriodEnd,
        leaseLane: input.current.leaseLane,
      }).session(session)
      if (
        !current ||
        !exactCurrentLifecycleSubscription(
          current.toObject() as CurrentLifecycleSubscription,
          userId,
          input.requestedAt,
        ) ||
        input.target.providerMode !== input.current.providerMode ||
        (
          input.operation === 'tier_change' &&
          (
            input.current.cancelAtPeriodEnd ||
            input.target.planKey === input.current.planKey
          )
        ) ||
        (
          input.operation === 'resubscribe' &&
          (
            !input.current.cancelAtPeriodEnd ||
            input.target.planKey !== input.current.planKey
          )
        )
      ) {
        throw failure(
          'lifecycle_conflict',
          'Current subscription changed before plan-change commit',
        )
      }

      const fenceKey =
        `${input.current.providerMode}:${userId.toHexString()}`
      const active = await PlanChangeRequest.findOne({
        activeFenceKey: fenceKey,
      }).session(session)
      if (active) {
        const supersedableCancellation =
          input.operation === 'resubscribe' &&
          active.operation === 'period_end_cancel' &&
          active.status === 'scheduled' &&
          sameObjectId(active.fromSubscriptionId, input.current._id) &&
          active.requestedEffectiveAt.getTime() ===
            input.current.currentPeriodEnd.getTime() &&
          active.oldCancellationEffectiveAt?.getTime() ===
            input.current.currentPeriodEnd.getTime()
        if (!supersedableCancellation) {
          throw failure(
            'lifecycle_conflict',
            'Another subscription lifecycle request is active',
          )
        }
        active.status = 'cancelled'
        active.outcome = 'superseded'
        active.outcomeAt = input.requestedAt
        active.outcomeReason =
          'Superseded by a customer-authorized replacement subscription'
        active.activeFenceKey = undefined
        active.nextRecoveryAt = undefined
        await active.save({ session })
      }

      const boundaryMs = input.current.currentPeriodEnd.getTime()
      const ttlBoundaryMs =
        input.requestedAt.getTime() +
        Math.min(24, input.target.reservationTtlHours) * 60 * 60 * 1_000
      const authorizationExpiresAt = new Date(
        Math.min(ttlBoundaryMs, boundaryMs - 1_000),
      )
      if (
        !exactEpochSecond(input.requestedAt) ||
        !exactEpochSecond(input.current.currentPeriodEnd) ||
        authorizationExpiresAt <= input.requestedAt ||
        authorizationExpiresAt >= input.current.currentPeriodEnd
      ) {
        throw failure(
          'lifecycle_conflict',
          'The next billing boundary is too close for authorization',
        )
      }
      const status = transitionPlanChangeStatus({
        operation: input.operation,
        currentStatus: 'requested',
        event: { type: 'start_authorization' },
      })
      const created = await PlanChangeRequest.create([{
        _id: requestId,
        userId,
        actorUserId: userId,
        source: 'customer',
        operation: input.operation,
        fromPlanKey: input.current.planKey,
        toPlanKey: input.target.planKey,
        targetCatalogVersion: input.target.catalogVersion,
        idempotencyKey: input.idempotencyKey,
        checkoutSelectionHash: input.selectionHash,
        requestedAt: input.requestedAt,
        requestedEffectiveAt: input.current.currentPeriodEnd,
        providerMode: input.current.providerMode,
        checkoutIntentId,
        fromSubscriptionId: input.current._id,
        fromRazorpaySubscriptionId:
          input.current.razorpaySubscriptionId,
        targetRazorpayPlanId: input.target.razorpayPlanId,
        activeFenceKey: fenceKey,
        status,
        authorizationExpiresAt,
        attempts: 0,
      }], { session })
      result = {
        planChangeRequestId: created[0]._id.toHexString(),
        checkoutIntentId: checkoutIntentId.toHexString(),
        effectiveAt: input.current.currentPeriodEnd,
        reused: false,
      }
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Plan-change transaction completed without a result',
    )
  }
  return result
}

/**
 * Creates the durable plan-change fence before any remote Razorpay call. The
 * production default remains inert while remote creation readiness is false.
 */
export async function initiateCustomerFuturePlanChange(
  unparsedInput: CustomerFuturePlanChangeInput,
  dependencies: CustomerFuturePlanChangeDependencies = {},
): Promise<CustomerFuturePlanChangeResult> {
  const input = normalizeFuturePlanChangeInput(unparsedInput)
  const lifecycleReady =
    dependencies.lifecycleReady ??
    PR6_FUTURE_SUBSCRIPTION_LIFECYCLE_READY
  const remoteCreationReady =
    dependencies.remoteCreationReady ??
    CURRENT_PAYMENT_CODE_READINESS.remoteCreationReady
  if (!lifecycleReady || !remoteCreationReady) {
    throw failure(
      'sale_blocked',
      'Future subscription creation is disabled',
    )
  }
  const resolveSaleContext =
    dependencies.resolveSaleContext ??
    resolveSubscriptionCheckoutSaleContext
  const saleContext = await resolveSaleContext(input.userId)
  const nowProvider = dependencies.now ?? (() => new Date())
  const observedNow = nowProvider()
  if (!validDate(observedNow)) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  const requestedAt = new Date(
    Math.floor(observedNow.getTime() / 1_000) * 1_000,
  )
  const loadCurrent =
    dependencies.loadCurrentSubscription ??
    defaultLoadCurrentLifecycleSubscription
  const current = await loadCurrent({
    userId: input.userId,
    now: requestedAt,
  })
  if (
    !current ||
    !exactCurrentLifecycleSubscription(
      current,
      new mongoose.Types.ObjectId(input.userId),
      requestedAt,
    )
  ) {
    throw failure(
      'lifecycle_conflict',
      'No single current paid subscription is available',
    )
  }
  const targetPlanKey = input.operation === 'resubscribe'
    ? current.planKey
    : input.targetPlanKey!
  if (
    (
      input.operation === 'tier_change' &&
      (
        current.cancelAtPeriodEnd ||
        targetPlanKey === current.planKey
      )
    ) ||
    (
      input.operation === 'resubscribe' &&
      !current.cancelAtPeriodEnd
    )
  ) {
    throw failure(
      'lifecycle_conflict',
      'Requested plan operation does not match current mandate state',
    )
  }
  const resolveTarget =
    dependencies.resolveCommercialTarget ??
    defaultResolveFutureCommercialTarget
  const target = await resolveTarget({
    userId: input.userId,
    targetPlanKey,
    manualCouponCode: input.manualCouponCode,
  })
  if (target.providerMode !== saleContext.providerMode) {
    throw failure(
      'commercial_conflict',
      'Lifecycle sale context changed before plan selection',
    )
  }
  if (
    target.providerMode !== current.providerMode ||
    target.planKey !== targetPlanKey
  ) {
    throw failure(
      'commercial_conflict',
      'Future plan does not match the current provider mode',
    )
  }
  const selectionHash = sha256CanonicalJson({
    operation: input.operation,
    targetPlanKey,
    manualCouponCode: input.manualCouponCode ?? null,
  })
  const persist =
    dependencies.persistPlanChange ??
    persistFuturePlanChangeMongo
  const persisted = await persist({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    selectionHash,
    operation: input.operation,
    current,
    target,
    requestedAt,
  })
  const createCheckout =
    dependencies.createFutureCheckout ??
    createFutureSubscriptionCheckout
  const checkout = await createCheckout({
    userId: input.userId,
    planChangeRequestId: persisted.planChangeRequestId,
    idempotencyKey: input.idempotencyKey,
    manualCouponCode: input.manualCouponCode,
  })
  if (
    checkout.intentId !== persisted.checkoutIntentId ||
    checkout.providerMode !== current.providerMode ||
    checkout.quote.planKey !== targetPlanKey ||
    checkout.quote.catalogVersion !== target.catalogVersion ||
    checkout.quote.firstPaidCycle.scheduledAt !==
      persisted.effectiveAt.toISOString()
  ) {
    throw failure(
      'persistence_conflict',
      'Future checkout does not match the durable plan change',
    )
  }
  return {
    planChangeRequestId: persisted.planChangeRequestId,
    effectiveAt: persisted.effectiveAt.toISOString(),
    checkout,
    reused: persisted.reused || checkout.reused,
  }
}

async function persistCustomerPeriodEndCancellationMongo(input: {
  userId: string
  idempotencyKey: string
  selectionHash: string
  current: CurrentCancellationSubscription
  requestedAt: Date
}): Promise<PersistedFuturePlanChange> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const session = await mongoose.startSession()
  let result: PersistedFuturePlanChange | undefined
  try {
    await session.withTransaction(async () => {
      const existing = await PlanChangeRequest.findOne({
        userId,
        source: 'customer',
        idempotencyKey: input.idempotencyKey,
      }).session(session)
      if (existing) {
        if (
          existing.operation !== 'period_end_cancel' ||
          existing.checkoutSelectionHash !== input.selectionHash ||
          !sameObjectId(
            existing.fromSubscriptionId,
            input.current._id,
          ) ||
          existing.fromRazorpaySubscriptionId !==
            input.current.razorpaySubscriptionId ||
          existing.requestedEffectiveAt.getTime() !==
            input.current.currentPeriodEnd.getTime()
        ) {
          throw failure(
            'lifecycle_conflict',
            'Idempotency key belongs to another lifecycle request',
          )
        }
        result = {
          planChangeRequestId: existing._id.toHexString(),
          checkoutIntentId: '',
          effectiveAt: existing.requestedEffectiveAt,
          reused: true,
        }
        return
      }
      const current = await Subscription.findOne({
        _id: input.current._id,
        userId,
        providerMode: input.current.providerMode,
        razorpaySubscriptionId:
          input.current.razorpaySubscriptionId,
        status: input.current.status,
        currentPeriodKey: input.current.currentPeriodKey,
        currentPeriodStart: input.current.currentPeriodStart,
        currentPeriodEnd: input.current.currentPeriodEnd,
        ...(input.current.status === 'authenticated'
          ? {
              checkoutIntentId: input.current.checkoutIntentId,
              planChangeRequestId: { $exists: false },
              replacesSubscriptionId: { $exists: false },
              leaseLane: 'a',
              requestedStartAt: input.current.requestedStartAt,
              couponCampaignId: input.current.couponCampaignId,
              discountedCyclesRemaining: 0,
            }
          : {}),
      }).session(session)
      if (!current) {
        throw failure(
          'lifecycle_conflict',
          'Current subscription changed before cancellation',
        )
      }
      if (input.current.status === 'authenticated') {
        const checkoutFilter = couponUpfrontCheckoutFilter(
          input.current,
          userId,
        )
        const checkout = checkoutFilter
          ? await CheckoutIntent.findOne(checkoutFilter)
              .session(session)
              .select('_id')
              .lean<{ _id: mongoose.Types.ObjectId }>()
          : null
        if (!checkout) {
          throw failure(
            'lifecycle_conflict',
            'Coupon checkout changed before cancellation',
          )
        }
      }
      const activeFenceKey =
        `${input.current.providerMode}:${input.userId}`
      const active = await PlanChangeRequest.findOne({
        activeFenceKey,
      }).session(session)
      if (active) {
        throw failure(
          'lifecycle_conflict',
          'Another subscription lifecycle request is active',
        )
      }
      const status = transitionPlanChangeStatus({
        operation: 'period_end_cancel',
        currentStatus: 'requested',
        event: { type: 'start_old_cancellation' },
      })
      const created = await PlanChangeRequest.create([{
        userId,
        actorUserId: userId,
        source: 'customer',
        operation: 'period_end_cancel',
        fromPlanKey: input.current.planKey,
        toPlanKey: 'free',
        targetCatalogVersion: input.current.catalogVersion,
        idempotencyKey: input.idempotencyKey,
        checkoutSelectionHash: input.selectionHash,
        requestedAt: input.requestedAt,
        requestedEffectiveAt: input.current.currentPeriodEnd,
        providerMode: input.current.providerMode,
        fromSubscriptionId: input.current._id,
        fromRazorpaySubscriptionId:
          input.current.razorpaySubscriptionId,
        activeFenceKey,
        status,
        attempts: 0,
      }], { session })
      result = {
        planChangeRequestId: created[0]._id.toHexString(),
        checkoutIntentId: '',
        effectiveAt: input.current.currentPeriodEnd,
        reused: false,
      }
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Cancellation transaction completed without a result',
    )
  }
  return result
}

/**
 * Starts a customer-owned period-end cancellation. Selling may be off, but
 * this separate destructive-operation readiness remains false until the
 * customer lifecycle routes complete QA.
 */
export async function initiateCustomerPeriodEndCancellation(
  input: {
    userId: string
    idempotencyKey: string
  },
  dependencies: CustomerPeriodEndCancellationDependencies = {},
): Promise<PeriodEndCancellationSubmissionResult> {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    !(dependencies.cancellationReady ??
      PR6_CUSTOMER_SUBSCRIPTION_CANCELLATION_READY)
  ) {
    throw failure('sale_blocked', 'Customer cancellation is disabled')
  }
  const idempotencyKey = CustomerBillingIdempotencyKeySchema.parse(
    input.idempotencyKey,
  )
  const observed = dependencies.now?.() ?? new Date()
  const requestedAt = new Date(
    Math.floor(observed.getTime() / 1_000) * 1_000,
  )
  if (!validDate(observed)) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  const loadCurrent =
    dependencies.loadCurrentSubscription ??
    defaultLoadCurrentCancellationSubscription
  const current = await loadCurrent({
    userId: input.userId,
    now: requestedAt,
  })
  if (
    !current ||
    !exactCurrentCancellationSubscription(
      current,
      new mongoose.Types.ObjectId(input.userId),
      requestedAt,
    )
  ) {
    throw failure(
      'lifecycle_conflict',
      'No single current paid subscription is available',
    )
  }
  const persist = dependencies.persistCancellationRequest ??
    persistCustomerPeriodEndCancellationMongo
  const persisted = await persist({
    userId: input.userId,
    idempotencyKey,
    selectionHash: sha256CanonicalJson({
      operation: 'period_end_cancel',
      confirmPeriodEnd: true,
    }),
    current,
    requestedAt,
  })
  const submit = dependencies.submitCancellation ??
    submitOldSubscriptionPeriodEndCancellation
  return submit({
    planChangeRequestId: persisted.planChangeRequestId,
    observedAt: requestedAt,
  })
}

function failure(
  code: SubscriptionLifecycleErrorCode,
  message: string,
  options?: ErrorOptions,
): SubscriptionLifecycleError {
  return new SubscriptionLifecycleError(code, message, options)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function exactEpochSecond(value: unknown): value is Date {
  return validDate(value) && value.getMilliseconds() === 0
}

function sameObjectId(
  left: mongoose.Types.ObjectId | undefined,
  right: mongoose.Types.ObjectId | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function normalizeVerificationInput(
  input: FutureSubscriptionAuthorizationVerificationInput,
): FutureSubscriptionAuthorizationVerificationInput {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    !OBJECT_ID_PATTERN.test(input.intentId) ||
    !PAYMENT_ID_PATTERN.test(input.razorpayPaymentId) ||
    !/^[a-fA-F0-9]{64}$/.test(input.signature)
  ) {
    throw failure(
      'invalid_request',
      'Future subscription authorization callback is invalid',
    )
  }
  return { ...input }
}

function normalizeTrustedAuthorizationObservation(
  input: TrustedFutureSubscriptionAuthorizationObservationInput,
): TrustedFutureSubscriptionAuthorizationObservationInput {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    !OBJECT_ID_PATTERN.test(input.intentId) ||
    !PAYMENT_ID_PATTERN.test(input.razorpayPaymentId)
  ) {
    throw failure(
      'invalid_request',
      'Trusted future subscription authorization identity is invalid',
    )
  }
  const payment = RazorpayPaymentDtoSchema.safeParse(input.payment)
  const subscription =
    RazorpaySubscriptionDtoSchema.safeParse(input.subscription)
  if (!payment.success || !subscription.success) {
    throw failure(
      'review_required',
      'Trusted future subscription provider evidence is invalid',
    )
  }
  return {
    ...input,
    payment: payment.data,
    subscription: subscription.data,
  }
}

function assertExactFutureAuthorizationContext(
  context: TrustedFutureAuthorizationContext,
  userId: string,
  intentId: string,
): void {
  const { intent, planChange, currentSubscription, lease } = context
  const controlLineage =
    classifyPlanChangeControlLineage(planChange)
  const expectedUserId = new mongoose.Types.ObjectId(userId)
  const expectedIntentId = new mongoose.Types.ObjectId(intentId)
  const expectedPurpose =
    planChange.operation === 'tier_change'
      ? 'replacement'
      : 'resubscribe'
  const expectedFence =
    `${intent.providerMode}:${expectedUserId.toHexString()}`
  const targetAuthorizationAlreadyCommitted =
    planChange.replacementAuthorizationPaymentId !== undefined ||
    planChange.replacementAuthorizedAt !== undefined ||
    planChange.toSubscriptionId !== undefined ||
    planChange.toRazorpaySubscriptionId !== undefined
  const initialAuthorizationState =
    planChange.status === 'authorization_pending' &&
    !targetAuthorizationAlreadyCommitted
  const committedAuthorizationState =
    (
      planChange.status === 'old_cancellation_pending' ||
      planChange.status === 'scheduled' ||
      planChange.status === 'reconciling'
    ) &&
    Boolean(
      planChange.replacementAuthorizationPaymentId &&
      validDate(planChange.replacementAuthorizedAt) &&
      planChange.toSubscriptionId &&
      planChange.toRazorpaySubscriptionId,
    )

  if (
    !intent._id.equals(expectedIntentId) ||
    !intent.userId.equals(expectedUserId) ||
    intent.kind !== 'subscription' ||
    (
      intent.purpose !== 'replacement' &&
      intent.purpose !== 'resubscribe'
    ) ||
    ![
      'remote_created',
      'checkout_opened',
      'authorization_pending',
      'review',
    ].includes(intent.status) ||
    !intent.planChangeRequestId.equals(planChange._id) ||
    !sameObjectId(planChange.checkoutIntentId, intent._id) ||
    !planChange.userId.equals(expectedUserId) ||
    controlLineage !== 'customer' ||
    planChange.providerMode !== intent.providerMode ||
    planChange.activeFenceKey !== expectedFence ||
    planChange.operation !==
      (intent.purpose === 'replacement' ? 'tier_change' : 'resubscribe') ||
    expectedPurpose !== intent.purpose ||
    planChange.toPlanKey !== intent.planKey ||
    planChange.targetCatalogVersion !== intent.catalogVersion ||
    planChange.targetRazorpayPlanId.trim().length === 0 ||
    !PLAN_ID_PATTERN.test(planChange.targetRazorpayPlanId) ||
    !planChange.fromSubscriptionId.equals(currentSubscription._id) ||
    planChange.fromRazorpaySubscriptionId !==
      currentSubscription.razorpaySubscriptionId ||
    !currentSubscription.userId.equals(expectedUserId) ||
    currentSubscription.providerMode !== intent.providerMode ||
    currentSubscription.planKey !== planChange.fromPlanKey ||
    !['active', 'pending', 'halted', 'paused'].includes(
      currentSubscription.status,
    ) ||
    !exactEpochSecond(currentSubscription.currentPeriodStart) ||
    !exactEpochSecond(currentSubscription.currentPeriodEnd) ||
    currentSubscription.currentPeriodStart >=
      currentSubscription.currentPeriodEnd ||
    currentSubscription.currentPeriodEnd.getTime() !==
      planChange.requestedEffectiveAt.getTime() ||
    currentSubscription.leaseLane === intent.leaseLane ||
    (
      initialAuthorizationState &&
      (
        intent.purpose === 'replacement'
          ? currentSubscription.cancelAtPeriodEnd
          : !currentSubscription.cancelAtPeriodEnd
      )
    ) ||
    !sameObjectId(lease.userId, expectedUserId) ||
    lease.providerMode !== intent.providerMode ||
    lease.lane !== intent.leaseLane ||
    !lease.ownerCheckoutIntentId.equals(intent._id) ||
    lease.razorpaySubscriptionId !== intent.razorpaySubscriptionId ||
    lease.status !== 'held' ||
    !SUBSCRIPTION_ID_PATTERN.test(intent.razorpaySubscriptionId) ||
    !exactEpochSecond(intent.requestedStartAt) ||
    !exactEpochSecond(intent.authorizationExpiresAt) ||
    intent.requestedStartAt.getTime() !==
      planChange.requestedEffectiveAt.getTime() ||
    intent.authorizationExpiresAt.getTime() !==
      planChange.authorizationExpiresAt.getTime() ||
    intent.authorizationExpiresAt >= intent.requestedStartAt ||
    !exactEpochSecond(planChange.requestedEffectiveAt) ||
    !exactEpochSecond(planChange.authorizationExpiresAt) ||
    !validDate(planChange.requestedAt) ||
    planChange.authorizationExpiresAt <= planChange.requestedAt ||
    planChange.authorizationExpiresAt >=
      planChange.requestedEffectiveAt ||
    (
      committedAuthorizationState &&
      planChange.operation === 'resubscribe' &&
      planChange.status !== 'scheduled'
    ) ||
    (!initialAuthorizationState && !committedAuthorizationState)
  ) {
    throw failure(
      'lifecycle_conflict',
      'Future subscription authorization lineage is inconsistent',
    )
  }
}

function toCommercialIntent(
  context: TrustedFutureAuthorizationContext,
): OriginalSubscriptionCheckoutIntent {
  const { intent, planChange } = context
  return {
    id: intent._id,
    userId: intent.userId,
    kind: 'subscription',
    providerMode: intent.providerMode,
    status: intent.status,
    purpose: intent.purpose,
    planChangeRequestId: intent.planChangeRequestId,
    replacesSubscriptionId: planChange.fromSubscriptionId,
    leaseLane: intent.leaseLane,
    requestedStartAt: intent.requestedStartAt,
    authorizationExpiresAt: intent.authorizationExpiresAt,
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    receipt: intent.receipt,
    createdAt: intent.createdAt,
    quote: {
      currency: intent.quoteSnapshot.currency,
      listPricePaise: intent.quoteSnapshot.listPricePaise,
      discountPaise: intent.quoteSnapshot.discountPaise,
      payablePaise: intent.quoteSnapshot.payablePaise,
      renewalPricePaise: intent.quoteSnapshot.renewalPricePaise,
      discountedBillingCycles:
        intent.quoteSnapshot.discountedBillingCycles,
      couponCampaignId: intent.quoteSnapshot.couponCampaignId,
      couponCampaignRevision:
        intent.quoteSnapshot.couponCampaignRevision,
    },
  }
}

async function buildAuthorizationExpectation(input: {
  context: TrustedFutureAuthorizationContext
  paymentId: string
  subscription: RazorpaySubscriptionDto
  resolver: SubscriptionCycleCommercialResolver
}): Promise<FutureSubscriptionAuthorizationExpectation> {
  const commercialIntent = toCommercialIntent(input.context)
  const reject = (conflict: string): never => {
    throw failure(
      'commercial_conflict',
      `Future subscription commercial evidence failed: ${conflict}`,
    )
  }
  assertSubscriptionCommercialIntent(
    commercialIntent,
    {
      expected: {
        providerMode: commercialIntent.providerMode,
        razorpaySubscriptionId:
          commercialIntent.razorpaySubscriptionId!,
      },
      strictLocalShape: { receipt: commercialIntent.receipt },
    },
    reject,
  )
  assertSubscriptionLifecycleIntent(commercialIntent, reject)
  const terms =
    (await input.resolver.resolve(commercialIntent)) ??
    reject('terms_not_found')
  const validated = requireSubscriptionCommercialTerms({
    intent: commercialIntent,
    terms,
    subscription: input.subscription,
    strictContentHashes: true,
    reject,
  })
  const { intent } = input.context
  return {
    providerMode: intent.providerMode,
    paymentId: input.paymentId,
    subscriptionId: intent.razorpaySubscriptionId,
    planId: validated.plan.razorpayPlanId,
    checkoutIntentId: intent._id.toHexString(),
    checkoutReceipt: intent.receipt,
    catalogVersion: intent.catalogVersion,
    purpose: intent.purpose,
    leaseLane: intent.leaseLane,
    planChangeRequestId: intent.planChangeRequestId.toHexString(),
    startAtEpochSeconds:
      Math.floor(intent.requestedStartAt.getTime() / 1_000),
    authorizationExpiresAtEpochSeconds:
      Math.floor(intent.authorizationExpiresAt.getTime() / 1_000),
    totalCount: intent.quoteSnapshot.subscriptionTotalCount,
  }
}

async function defaultLoadFutureAuthorizationContext(input: {
  userId: string
  intentId: string
}): Promise<TrustedFutureAuthorizationContext | null> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const intentId = new mongoose.Types.ObjectId(input.intentId)
  const intent = await CheckoutIntent.findOne({
    _id: intentId,
    userId,
    kind: 'subscription',
  }).select([
    '_id',
    'userId',
    'kind',
    'providerMode',
    'purpose',
    'planChangeRequestId',
    'leaseLane',
    'requestedStartAt',
    'authorizationExpiresAt',
    'planKey',
    'catalogVersion',
    'status',
    'razorpaySubscriptionId',
    'receipt',
    'createdAt',
    'quoteSnapshot',
  ].join(' ')).lean<FutureAuthorizationCheckoutRow>()
  if (
    !intent ||
    !intent.planChangeRequestId ||
    !intent.leaseLane ||
    !intent.razorpaySubscriptionId
  ) {
    return null
  }
  const planChange = await PlanChangeRequest.findOne({
    _id: intent.planChangeRequestId,
    userId,
    checkoutIntentId: intent._id,
  }).lean<FutureAuthorizationPlanChangeRow>()
  if (!planChange?.fromSubscriptionId) return null
  const [currentSubscription, lease] = await Promise.all([
    Subscription.findOne({
      _id: planChange.fromSubscriptionId,
      userId,
    }).lean<FutureAuthorizationCurrentSubscriptionRow>(),
    ConsumerSubscriptionLease.findOne({
      userId,
      providerMode: intent.providerMode,
      lane: intent.leaseLane,
      ownerCheckoutIntentId: intent._id,
    }).lean<FutureAuthorizationLeaseRow>(),
  ])
  if (!currentSubscription || !lease) return null
  return {
    intent,
    planChange,
    currentSubscription,
    lease,
  }
}

async function markFutureAuthorizationReviewMongo(input: {
  context: TrustedFutureAuthorizationContext
  reason: string
  observedAt: Date
  payment?: RazorpayPaymentDto
  subscription?: RazorpaySubscriptionDto
}): Promise<void> {
  await connectDB()
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const { context } = input
      const controlFilter =
        exactPlanChangeControlFilter(context.planChange)
      if (
        classifyPlanChangeControlLineage(context.planChange) !==
          'customer' ||
        !controlFilter
      ) {
        throw failure(
          'lifecycle_conflict',
          'Plan change control lineage is not customer-actionable',
        )
      }
      const request = await PlanChangeRequest.findOne({
        _id: context.planChange._id,
        userId: context.planChange.userId,
        ...controlFilter,
        activeFenceKey: context.planChange.activeFenceKey,
        status: context.planChange.status,
      }).session(session)
      if (!request) {
        throw failure(
          'persistence_conflict',
          'Plan change moved while entering review',
        )
      }
      request.status = transitionPlanChangeStatus({
        operation: request.operation,
        currentStatus: request.status,
        event: { type: 'review_required' },
      })
      request.lastProviderObservedAt = input.observedAt
      request.lastError = input.reason.slice(0, 2_000)
      request.providerSnapshot = {
        reason: input.reason,
        payment: input.payment,
        subscription: input.subscription,
      }
      request.attempts += 1
      await request.save({ session })
      await CheckoutIntent.updateOne(
        {
          _id: context.intent._id,
          userId: context.intent.userId,
          providerMode: context.intent.providerMode,
        },
        { $set: { status: 'review' }, $unset: { nextRecoveryAt: 1 } },
        { session, runValidators: true },
      )
      await ConsumerSubscriptionLease.updateOne(
        {
          _id: context.lease._id,
          ownerCheckoutIntentId: context.intent._id,
          status: { $ne: 'released' },
        },
        { $set: { status: 'review' } },
        { session, runValidators: true },
      )
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
}

function exactExistingTargetSubscription(
  target: ISubscription,
  input: {
    context: TrustedFutureAuthorizationContext
    subscription: RazorpaySubscriptionDto
  },
): boolean {
  const { context, subscription } = input
  return (
    target.userId.equals(context.intent.userId) &&
    target.providerMode === context.intent.providerMode &&
    target.planKey === context.intent.planKey &&
    target.catalogVersion === context.intent.catalogVersion &&
    target.razorpayPlanId === context.planChange.targetRazorpayPlanId &&
    target.razorpaySubscriptionId === subscription.id &&
    sameObjectId(target.checkoutIntentId, context.intent._id) &&
    sameObjectId(
      target.planChangeRequestId,
      context.planChange._id,
    ) &&
    sameObjectId(
      target.replacesSubscriptionId,
      context.currentSubscription._id,
    ) &&
    target.leaseLane === context.intent.leaseLane &&
    target.requestedStartAt?.getTime() ===
      context.intent.requestedStartAt.getTime() &&
    target.authorizationExpiresAt?.getTime() ===
      context.intent.authorizationExpiresAt.getTime() &&
    (
      target.status === 'created' ||
      target.status === 'authenticated'
    ) &&
    target.currentPeriodKey === undefined &&
    target.currentPeriodStart === undefined &&
    target.currentPeriodEnd === undefined &&
    target.cancelAtPeriodEnd === false
  )
}

async function commitAcceptedFutureAuthorizationMongo(input: {
  context: TrustedFutureAuthorizationContext
  payment: RazorpayPaymentDto
  subscription: RazorpaySubscriptionDto
  authenticatedAt: Date
}): Promise<{
  reused: boolean
  status: 'old_cancellation_pending' | 'scheduled' | 'review'
}> {
  await connectDB()
  const session = await mongoose.startSession()
  let result:
    | {
        reused: boolean
        status: 'old_cancellation_pending' | 'scheduled' | 'review'
      }
    | undefined
  try {
    await session.withTransaction(async () => {
      const { context, payment, subscription, authenticatedAt } = input
      const controlFilter =
        exactPlanChangeControlFilter(context.planChange)
      if (
        classifyPlanChangeControlLineage(context.planChange) !==
          'customer' ||
        !controlFilter
      ) {
        throw failure(
          'lifecycle_conflict',
          'Plan change control lineage is not customer-actionable',
        )
      }
      const request = await PlanChangeRequest.findOne({
        _id: context.planChange._id,
        userId: context.planChange.userId,
        ...controlFilter,
        checkoutIntentId: context.intent._id,
        activeFenceKey: context.planChange.activeFenceKey,
      }).session(session)
      if (!request) {
        throw failure(
          'persistence_conflict',
          'Plan change was not available for authorization',
        )
      }

      if (request.replacementAuthorizationPaymentId) {
        const target = request.toSubscriptionId
          ? await Subscription.findById(request.toSubscriptionId)
            .session(session)
          : null
        if (
          request.replacementAuthorizationPaymentId !== payment.id ||
          request.toRazorpaySubscriptionId !== subscription.id ||
          !target ||
          !exactExistingTargetSubscription(target, input) ||
          (
            request.status !== 'old_cancellation_pending' &&
            request.status !== 'scheduled' &&
            request.status !== 'reconciling'
          )
        ) {
          throw failure(
            'persistence_conflict',
            'Authorization replay conflicts with committed evidence',
          )
        }
        result = {
          reused: true,
          status: request.operation === 'resubscribe'
            ? 'scheduled'
            : 'old_cancellation_pending',
        }
        return
      }

      if (
        request.status !== 'authorization_pending' ||
        request.operation !== context.planChange.operation ||
        request.authorizationExpiresAt?.getTime() !==
          context.intent.authorizationExpiresAt.getTime() ||
        request.requestedEffectiveAt.getTime() !==
          context.intent.requestedStartAt.getTime() ||
        authenticatedAt >= context.intent.authorizationExpiresAt
      ) {
        throw failure(
          'persistence_conflict',
          'Authorization window or lifecycle state changed',
        )
      }

      const quote = context.intent.quoteSnapshot
      let target = await Subscription.findOne({
        providerMode: context.intent.providerMode,
        razorpaySubscriptionId: subscription.id,
      }).session(session)
      let reused = true
      if (!target) {
        const created = await Subscription.create([{
          userId: context.intent.userId,
          providerMode: context.intent.providerMode,
          planKey: context.intent.planKey,
          catalogVersion: context.intent.catalogVersion,
          razorpayPlanId: context.planChange.targetRazorpayPlanId,
          razorpaySubscriptionId: subscription.id,
          checkoutIntentId: context.intent._id,
          planChangeRequestId: context.planChange._id,
          replacesSubscriptionId: context.currentSubscription._id,
          leaseLane: context.intent.leaseLane,
          requestedStartAt: context.intent.requestedStartAt,
          authorizationExpiresAt:
            context.intent.authorizationExpiresAt,
          status: 'authenticated',
          cancelAtPeriodEnd: false,
          couponCampaignId: quote.couponCampaignId,
          discountedCyclesRemaining:
            quote.discountedBillingCycles,
          source: 'customer',
        }], { session })
        target = created[0]
        reused = false
      } else if (!exactExistingTargetSubscription(target, input)) {
        throw failure(
          'persistence_conflict',
          'Provider subscription belongs to different local lineage',
        )
      }

      if (
        quote.couponCampaignId &&
        quote.couponCampaignRevision !== undefined
      ) {
        const coupon = await commitCouponReservationAuthorizationInSession({
          providerMode: context.intent.providerMode,
          campaignId: quote.couponCampaignId.toHexString(),
          campaignRevision: quote.couponCampaignRevision,
          userId: context.intent.userId.toHexString(),
          checkoutIntentId: context.intent._id.toHexString(),
          providerSubscriptionId: subscription.id,
          authorizationPaymentId: payment.id,
          authenticatedAt,
        }, session)
        if (coupon.requiresReview) {
          request.status = transitionPlanChangeStatus({
            operation: request.operation,
            currentStatus: request.status,
            event: { type: 'review_required' },
          })
          request.lastProviderObservedAt = authenticatedAt
          request.lastError =
            'Coupon authorization capacity requires review'
          request.providerSnapshot = { payment, subscription }
          request.toSubscriptionId = target._id
          request.toRazorpaySubscriptionId = subscription.id
          request.replacementAuthorizationPaymentId = payment.id
          request.replacementAuthorizedAt = authenticatedAt
          request.attempts += 1
          await request.save({ session })
          target.status = 'review'
          await target.save({ session })
          const intentReview = await CheckoutIntent.updateOne(
            {
              _id: context.intent._id,
              userId: context.intent.userId,
              providerMode: context.intent.providerMode,
              razorpaySubscriptionId: subscription.id,
            },
            { $set: { status: 'review' }, $unset: { nextRecoveryAt: 1 } },
            { session, runValidators: true },
          )
          const leaseReview = await ConsumerSubscriptionLease.updateOne(
            {
              _id: context.lease._id,
              ownerCheckoutIntentId: context.intent._id,
              razorpaySubscriptionId: subscription.id,
              status: { $ne: 'released' },
            },
            { $set: { status: 'review' } },
            { session, runValidators: true },
          )
          if (
            intentReview.matchedCount !== 1 ||
            leaseReview.matchedCount !== 1
          ) {
            throw failure(
              'persistence_conflict',
              'Authorization review lineage could not be fenced',
            )
          }
          result = { reused, status: 'review' }
          return
        }
      } else if (
        quote.couponCampaignId ||
        quote.couponCampaignRevision !== undefined ||
        quote.discountPaise !== 0
      ) {
        throw failure(
          'commercial_conflict',
          'Authorization has an incomplete coupon tuple',
        )
      }

      const nextStatus = transitionPlanChangeStatus({
        operation: request.operation,
        currentStatus: request.status,
        event: {
          type: 'replacement_authorized',
          evidence: {
            paymentId: payment.id,
            authorizedAt: authenticatedAt,
          },
        },
      })
      request.status = nextStatus
      request.toSubscriptionId = target._id
      request.toRazorpaySubscriptionId = subscription.id
      request.replacementAuthorizationPaymentId = payment.id
      request.replacementAuthorizedAt = authenticatedAt
      request.lastProviderObservedAt = authenticatedAt
      request.providerSnapshot = { payment, subscription }
      request.attempts += 1
      request.lastError = undefined
      request.nextRecoveryAt = nextStatus === 'scheduled'
        ? request.requestedEffectiveAt
        : undefined
      await request.save({ session })

      const intentUpdate = await CheckoutIntent.updateOne(
        {
          _id: context.intent._id,
          userId: context.intent.userId,
          providerMode: context.intent.providerMode,
          purpose: context.intent.purpose,
          planChangeRequestId: context.planChange._id,
          razorpaySubscriptionId: subscription.id,
          status: {
            $in: [
              'remote_created',
              'checkout_opened',
              'authorization_pending',
            ],
          },
        },
        {
          $set: { status: 'authorization_pending' },
          $unset: { nextRecoveryAt: 1 },
        },
        { session, runValidators: true },
      )
      if (intentUpdate.matchedCount !== 1) {
        throw failure(
          'persistence_conflict',
          'Checkout intent moved during authorization',
        )
      }
      result = {
        reused,
        status: nextStatus as 'old_cancellation_pending' | 'scheduled',
      }
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Authorization transaction completed without a result',
    )
  }
  return result
}

async function defaultLoadCancellationContext(input: {
  planChangeRequestId: string
}): Promise<{
  request: CancellationRequestRow
  subscription: CancellationSubscriptionRow
} | null> {
  if (!OBJECT_ID_PATTERN.test(input.planChangeRequestId)) return null
  await connectDB()
  const request = await PlanChangeRequest.findById(
    input.planChangeRequestId,
  ).lean<CancellationRequestRow>()
  if (!request) return null
  const subscription = await Subscription.findOne({
    _id: request.fromSubscriptionId,
    userId: request.userId,
    providerMode: request.providerMode,
    razorpaySubscriptionId: request.fromRazorpaySubscriptionId,
  }).lean<CancellationSubscriptionRow>()
  return subscription ? { request, subscription } : null
}

function assertCancellationContext(input: {
  request: CancellationRequestRow
  subscription: CancellationSubscriptionRow
}): void {
  const { request, subscription } = input
  const controlLineage =
    classifyPlanChangeControlLineage(request)
  const couponUpfrontCancellation =
    request.operation === 'period_end_cancel' &&
    couponUpfrontCancellationLineage(subscription) &&
    (
      subscription.status === 'authenticated' ||
      subscription.status === 'cancelled' ||
      subscription.status === 'completed' ||
      subscription.status === 'expired'
    )
  const scheduledReplay =
    request.status === 'scheduled' &&
    subscription.cancelAtPeriodEnd &&
    (
      subscription.status === 'cancelled' ||
      subscription.status === 'completed' ||
      subscription.status === 'expired'
    )
  if (
    controlLineage !== 'customer' ||
    (
      request.operation !== 'tier_change' &&
      request.operation !== 'period_end_cancel'
    ) ||
    !request.fromSubscriptionId.equals(subscription._id) ||
    !request.userId.equals(subscription.userId) ||
    request.providerMode !== subscription.providerMode ||
    request.fromRazorpaySubscriptionId !==
      subscription.razorpaySubscriptionId ||
    !SUBSCRIPTION_ID_PATTERN.test(subscription.razorpaySubscriptionId) ||
    !exactEpochSecond(subscription.currentPeriodStart) ||
    !exactEpochSecond(subscription.currentPeriodEnd) ||
    subscription.currentPeriodStart >= subscription.currentPeriodEnd ||
    request.requestedEffectiveAt.getTime() !==
      subscription.currentPeriodEnd.getTime() ||
    (
      request.status !== 'old_cancellation_pending' &&
      request.status !== 'reconciling' &&
      request.status !== 'scheduled'
    ) ||
    !(
      ['active', 'pending', 'halted', 'paused'].includes(
        subscription.status,
      ) ||
      couponUpfrontCancellation ||
      scheduledReplay
    )
  ) {
    throw failure(
      'lifecycle_conflict',
      'Period-end cancellation lineage is inconsistent',
    )
  }
}

async function commitCancellationAcceptedMongo(input: {
  request: CancellationRequestRow
  subscription: CancellationSubscriptionRow
  provider: RazorpaySubscriptionDto
  observedAt: Date
}): Promise<{ reused: boolean }> {
  await connectDB()
  const session = await mongoose.startSession()
  let reused = false
  try {
    await session.withTransaction(async () => {
      const controlFilter =
        exactPlanChangeControlFilter(input.request)
      if (
        classifyPlanChangeControlLineage(input.request) !==
          'customer' ||
        !controlFilter
      ) {
        throw failure(
          'lifecycle_conflict',
          'Cancellation control lineage is not customer-actionable',
        )
      }
      const request = await PlanChangeRequest.findOne({
        _id: input.request._id,
        userId: input.request.userId,
        ...controlFilter,
        providerMode: input.request.providerMode,
        fromSubscriptionId: input.subscription._id,
        fromRazorpaySubscriptionId:
          input.subscription.razorpaySubscriptionId,
      }).session(session)
      const subscription = await Subscription.findById(
        input.subscription._id,
      ).session(session)
      if (!request || !subscription) {
        throw failure(
          'persistence_conflict',
          'Cancellation records disappeared before commit',
        )
      }
      const couponUpfrontCancellation =
        input.request.operation === 'period_end_cancel' &&
        couponUpfrontCancellationLineage(input.subscription)
      const providerBoundary = couponUpfrontCancellation
        ? input.subscription.currentPeriodEnd
        : new Date(
            (input.provider.currentEndEpochSeconds ?? Number.NaN) * 1_000,
          )
      const providerEvidenceExact = couponUpfrontCancellation
        ? (
            ['cancelled', 'completed', 'expired'].includes(
              input.provider.status,
            ) &&
            input.provider.startAtEpochSeconds !== undefined &&
            input.provider.startAtEpochSeconds * 1_000 ===
              request.requestedEffectiveAt.getTime()
          )
        : (
            input.provider.scheduledChangeAtEpochSeconds ===
              input.provider.currentEndEpochSeconds
          )
      if (
        input.provider.id !== subscription.razorpaySubscriptionId ||
        input.provider.providerMode !== subscription.providerMode ||
        input.provider.planId !== subscription.razorpayPlanId ||
        (
          couponUpfrontCancellation &&
          input.provider.offerId !== undefined
        ) ||
        !validDate(providerBoundary) ||
        providerBoundary.getTime() !==
          request.requestedEffectiveAt.getTime() ||
        !providerEvidenceExact
      ) {
        throw failure(
          'review_required',
          'Provider cancellation boundary does not match the promise',
        )
      }
      if (request.status === 'scheduled') {
        if (
          !request.oldCancellationAcceptedAt ||
          request.oldCancellationEffectiveAt?.getTime() !==
            providerBoundary.getTime() ||
          !subscription.cancelAtPeriodEnd
        ) {
          throw failure(
            'persistence_conflict',
            'Cancellation replay found divergent local evidence',
          )
        }
        reused = true
        return
      }

      let status: PlanChangeRequestStatus =
        request.status as PlanChangeRequestStatus
      if (status === 'reconciling') {
        status = transitionPlanChangeStatus({
          operation: request.operation,
          currentStatus: status,
          event: {
            type: 'recovery_resolved',
            resumeAt: 'old_cancellation_pending',
            evidence: request.operation === 'tier_change'
              ? {
                  replacementAuthorization: {
                    paymentId:
                      request.replacementAuthorizationPaymentId!,
                    authorizedAt: request.replacementAuthorizedAt!,
                  },
                }
              : undefined,
          },
        })
      }
      status = transitionPlanChangeStatus({
        operation: request.operation,
        currentStatus: status,
        event: {
          type: 'old_cancellation_accepted',
          evidence: {
            acceptedAt: input.observedAt,
            effectiveAt: providerBoundary,
          },
        },
      })
      request.status = status
      request.oldCancellationAcceptedAt = input.observedAt
      request.oldCancellationEffectiveAt = providerBoundary
      request.lastProviderObservedAt = input.observedAt
      request.providerSnapshot = input.provider
      request.nextRecoveryAt = request.requestedEffectiveAt
      request.lastError = undefined
      request.attempts += 1
      await request.save({ session })

      subscription.cancelAtPeriodEnd = true
      if (
        request.operation === 'tier_change' &&
        (request.toPlanKey === 'plus' || request.toPlanKey === 'pro')
      ) {
        subscription.scheduledPlanChange = {
          targetPlanKey: request.toPlanKey,
          effectiveAt: request.requestedEffectiveAt,
          requestedAt: request.requestedAt,
          source: 'customer',
          planChangeRequestId: request._id,
        }
      } else {
        subscription.scheduledPlanChange = undefined
      }
      await subscription.save({ session })
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  return { reused }
}

async function markCancellationUncertainMongo(input: {
  request: CancellationRequestRow
  observedAt: Date
  reason: string
}): Promise<void> {
  await connectDB()
  const controlFilter =
    exactPlanChangeControlFilter(input.request)
  if (
    classifyPlanChangeControlLineage(input.request) !== 'customer' ||
    !controlFilter
  ) {
    throw failure(
      'lifecycle_conflict',
      'Cancellation control lineage is not customer-actionable',
    )
  }
  const nextRecoveryAt = new Date(
    input.observedAt.getTime() + RECOVERY_DELAY_MS,
  )
  const nextStatus = transitionPlanChangeStatus({
    operation: input.request.operation,
    currentStatus: input.request.status,
    event: { type: 'provider_uncertain' },
  })
  const update = await PlanChangeRequest.updateOne(
    {
      _id: input.request._id,
      userId: input.request.userId,
      ...controlFilter,
      providerMode: input.request.providerMode,
      status: {
        $in: ['old_cancellation_pending', 'reconciling'],
      },
    },
    {
      $set: {
        status: nextStatus,
        nextRecoveryAt,
        lastProviderObservedAt: input.observedAt,
        lastError: input.reason.slice(0, 2_000),
      },
      $inc: { attempts: 1 },
    },
    { runValidators: true },
  )
  if (update.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Cancellation state moved while scheduling recovery',
    )
  }
}

let cachedRazorpayClientFactory: RazorpayClientFactory | undefined
let cachedCancellationClientFactory:
  | RazorpaySubscriptionCancellationClientFactory
  | undefined

function defaultRazorpayClientFactory(): RazorpayClientFactory {
  cachedRazorpayClientFactory ??= createRazorpayClientFactory()
  return cachedRazorpayClientFactory
}

function defaultCancellationClientFactory():
RazorpaySubscriptionCancellationClientFactory {
  cachedCancellationClientFactory ??=
    createRazorpaySubscriptionCancellationClientFactory()
  return cachedCancellationClientFactory
}

export async function submitOldSubscriptionPeriodEndCancellation(
  input: {
    planChangeRequestId: string
    observedAt?: Date
  },
  dependencies: PeriodEndCancellationDependencies = {},
): Promise<PeriodEndCancellationSubmissionResult> {
  if (!OBJECT_ID_PATTERN.test(input.planChangeRequestId)) {
    throw failure('invalid_request', 'Plan change identifier is invalid')
  }
  const observedAt = input.observedAt ?? new Date()
  if (!validDate(observedAt)) {
    throw failure('invalid_request', 'Cancellation observation time is invalid')
  }
  const load =
    dependencies.loadCancellationContext ??
    defaultLoadCancellationContext
  const context = await load({
    planChangeRequestId: input.planChangeRequestId,
  })
  if (!context) {
    throw failure('not_found', 'Plan change was not found')
  }
  assertCancellationContext(context)
  if (
    context.request.status === 'scheduled' &&
    context.request.oldCancellationAcceptedAt &&
    context.request.oldCancellationEffectiveAt &&
    context.subscription.cancelAtPeriodEnd
  ) {
    return {
      planChangeRequestId: context.request._id.toHexString(),
      status: 'scheduled',
      effectiveAt:
        context.request.requestedEffectiveAt.toISOString(),
      reused: true,
    }
  }

  const factory =
    dependencies.cancellationClientFactory ??
    defaultCancellationClientFactory()
  let provider: RazorpaySubscriptionDto
  try {
    const client = factory.forMode(context.request.providerMode)
    provider = context.request.operation === 'period_end_cancel' &&
      couponUpfrontCancellationLineage(context.subscription)
      ? await client.cancelSubscriptionImmediately(
          context.subscription.razorpaySubscriptionId,
        )
      : await client.cancelSubscriptionAtCycleEnd(
          context.subscription.razorpaySubscriptionId,
        )
  } catch (error) {
    const markUncertain =
      dependencies.markCancellationUncertain ??
      markCancellationUncertainMongo
    await markUncertain({
      request: context.request,
      observedAt,
      reason: 'Provider cancellation result is ambiguous',
    })
    return {
      planChangeRequestId: context.request._id.toHexString(),
      status: 'reconciling',
      effectiveAt:
        context.request.requestedEffectiveAt.toISOString(),
      reused: false,
      pollAfterMs: RECOVERY_DELAY_MS,
    }
  }

  const commit =
    dependencies.commitCancellationAccepted ??
    commitCancellationAcceptedMongo
  const committed = await commit({
    ...context,
    provider,
    observedAt,
  })
  return {
    planChangeRequestId: context.request._id.toHexString(),
    status: 'scheduled',
    effectiveAt: context.request.requestedEffectiveAt.toISOString(),
    reused: committed.reused,
  }
}

function publicAuthorizationDecision(
  intentId: string,
  planChangeRequestId: string,
  decision: FutureSubscriptionAuthorizationDecision,
): FutureSubscriptionAuthorizationVerificationResult {
  if (decision.decision === 'retry') {
    return {
      intentId,
      planChangeRequestId,
      status: 'authorization_pending',
      pollAfterMs: 5_000,
      reused: false,
    }
  }
  return {
    intentId,
    planChangeRequestId,
    status: 'manual_review',
    reused: false,
  }
}

export async function verifyFutureSubscriptionAuthorization(
  unparsedInput: FutureSubscriptionAuthorizationVerificationInput,
  dependencies: FutureSubscriptionAuthorizationDependencies = {},
): Promise<FutureSubscriptionAuthorizationVerificationResult> {
  const input = normalizeVerificationInput(unparsedInput)
  const nowProvider = dependencies.now ?? (() => new Date())
  const observedAt = nowProvider()
  if (!validDate(observedAt)) {
    throw failure('invalid_request', 'Authorization observation time is invalid')
  }
  const load = dependencies.loadContext ??
    defaultLoadFutureAuthorizationContext
  const context = await load({
    userId: input.userId,
    intentId: input.intentId,
  })
  if (!context) {
    throw failure('not_found', 'Future subscription checkout was not found')
  }
  assertExactFutureAuthorizationContext(
    context,
    input.userId,
    input.intentId,
  )

  const loadKeySecret = dependencies.loadKeySecret ??
    ((mode: ProviderMode) =>
      loadRazorpayApiCredentials(mode).keySecret)
  if (!verifyRazorpaySubscriptionCheckoutSignature({
    razorpayPaymentId: input.razorpayPaymentId,
    trustedSubscriptionId:
      context.intent.razorpaySubscriptionId,
    signature: input.signature,
    keySecret: loadKeySecret(context.intent.providerMode),
  })) {
    throw failure('signature_invalid', 'Checkout signature is invalid')
  }

  if (context.planChange.replacementAuthorizationPaymentId) {
    return resolveCommittedFutureAuthorization({
      context,
      intentId: input.intentId,
      paymentId: input.razorpayPaymentId,
      observedAt,
      dependencies,
    })
  }

  const clientFactory =
    dependencies.clientFactory ?? defaultRazorpayClientFactory()
  const client = clientFactory.forMode(context.intent.providerMode)
  let payment: RazorpayPaymentDto
  let subscription: RazorpaySubscriptionDto
  try {
    ;[payment, subscription] = await Promise.all([
      client.fetchPayment(input.razorpayPaymentId),
      client.fetchSubscription(
        context.intent.razorpaySubscriptionId,
      ),
    ])
  } catch (error) {
    throw failure(
      'provider_unavailable',
      'Provider evidence could not be fetched',
      { cause: error },
    )
  }

  const trusted = normalizeTrustedAuthorizationObservation({
    userId: input.userId,
    intentId: input.intentId,
    razorpayPaymentId: input.razorpayPaymentId,
    payment,
    subscription,
  })
  return processFutureAuthorizationEvidence({
    ...trusted,
    context,
    observedAt,
    dependencies,
  })
}

async function resolveCommittedFutureAuthorization(input: {
  context: TrustedFutureAuthorizationContext
  intentId: string
  paymentId: string
  observedSubscriptionId?: string
  observedAt: Date
  dependencies: FutureSubscriptionAuthorizationDependencies
}): Promise<FutureSubscriptionAuthorizationVerificationResult> {
  const { context, dependencies } = input
  const planChangeRequestId =
    context.planChange._id.toHexString()
  if (
    context.planChange.replacementAuthorizationPaymentId !==
      input.paymentId ||
    context.planChange.toRazorpaySubscriptionId !==
      context.intent.razorpaySubscriptionId ||
    (
      input.observedSubscriptionId !== undefined &&
      input.observedSubscriptionId !==
        context.intent.razorpaySubscriptionId
    )
  ) {
    const markReview = dependencies.markReview ??
      markFutureAuthorizationReviewMongo
    await markReview({
      context,
      reason: 'Authorization callback conflicts with committed evidence',
      observedAt: input.observedAt,
    })
    return {
      intentId: input.intentId,
      planChangeRequestId,
      status: 'manual_review',
      reused: false,
    }
  }
  if (context.planChange.status === 'scheduled') {
    return {
      intentId: input.intentId,
      planChangeRequestId,
      status: 'scheduled',
      reused: true,
    }
  }
  if (
    context.planChange.operation !== 'tier_change' ||
    (
      context.planChange.status !== 'old_cancellation_pending' &&
      context.planChange.status !== 'reconciling'
    )
  ) {
    throw failure(
      'lifecycle_conflict',
      'Committed authorization cannot resume old mandate cancellation',
    )
  }
  const submitCancellation = dependencies.submitOldCancellation ??
    ((submission) =>
      submitOldSubscriptionPeriodEndCancellation(submission))
  const cancellation = await submitCancellation({
    planChangeRequestId,
    observedAt: input.observedAt,
  })
  return {
    intentId: input.intentId,
    planChangeRequestId,
    status: cancellation.status,
    ...(cancellation.pollAfterMs
      ? { pollAfterMs: cancellation.pollAfterMs }
      : {}),
    reused: cancellation.reused,
  }
}

async function processFutureAuthorizationEvidence(input: {
  userId: string
  intentId: string
  razorpayPaymentId: string
  payment: RazorpayPaymentDto
  subscription: RazorpaySubscriptionDto
  context: TrustedFutureAuthorizationContext
  observedAt: Date
  dependencies: FutureSubscriptionAuthorizationDependencies
}): Promise<FutureSubscriptionAuthorizationVerificationResult> {
  const {
    context,
    dependencies,
    payment,
    subscription,
    observedAt,
  } = input
  if (
    context.planChange.replacementAuthorizationPaymentId &&
    (
      context.planChange.replacementAuthorizationPaymentId !==
        input.razorpayPaymentId ||
      context.planChange.toRazorpaySubscriptionId !== subscription.id
    )
  ) {
    return resolveCommittedFutureAuthorization({
      context,
      intentId: input.intentId,
      paymentId: input.razorpayPaymentId,
      observedSubscriptionId: subscription.id,
      observedAt,
      dependencies,
    })
  }
  const resolver =
    dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver
  const expectation = await buildAuthorizationExpectation({
    context,
    paymentId: input.razorpayPaymentId,
    subscription,
    resolver,
  })
  const authorizationObservedAt =
    context.planChange.replacementAuthorizedAt ?? observedAt
  if (!validDate(authorizationObservedAt)) {
    throw failure(
      'lifecycle_conflict',
      'Committed authorization time is invalid',
    )
  }
  const decision = classifyFutureSubscriptionAuthorizationEvidence({
    expectation,
    payment,
    subscription,
    observedAtEpochSeconds:
      Math.floor(authorizationObservedAt.getTime() / 1_000),
  })
  if (decision.decision !== 'accept_authorization') {
    if (decision.decision !== 'retry') {
      const markReview = dependencies.markReview ??
        markFutureAuthorizationReviewMongo
      await markReview({
        context,
        reason: decision.reason,
        observedAt,
        payment,
        subscription,
      })
    }
    return publicAuthorizationDecision(
      input.intentId,
      context.planChange._id.toHexString(),
      decision,
    )
  }

  if (context.planChange.replacementAuthorizationPaymentId) {
    return resolveCommittedFutureAuthorization({
      context,
      intentId: input.intentId,
      paymentId: input.razorpayPaymentId,
      observedSubscriptionId: subscription.id,
      observedAt,
      dependencies,
    })
  }

  const commit =
    dependencies.commitAcceptedAuthorization ??
    commitAcceptedFutureAuthorizationMongo
  const committed = await commit({
    context,
    payment,
    subscription,
    authenticatedAt: observedAt,
  })
  if (committed.status === 'review') {
    return {
      intentId: input.intentId,
      planChangeRequestId:
        context.planChange._id.toHexString(),
      status: 'manual_review',
      reused: committed.reused,
    }
  }
  if (committed.status === 'scheduled') {
    return {
      intentId: input.intentId,
      planChangeRequestId:
        context.planChange._id.toHexString(),
      status: 'scheduled',
      reused: committed.reused,
    }
  }

  const submitCancellation = dependencies.submitOldCancellation ??
    ((submission) =>
      submitOldSubscriptionPeriodEndCancellation(submission))
  const cancellation = await submitCancellation({
    planChangeRequestId:
      context.planChange._id.toHexString(),
    observedAt,
  })
  return {
    intentId: input.intentId,
    planChangeRequestId:
      context.planChange._id.toHexString(),
    status: cancellation.status,
    ...(cancellation.pollAfterMs
      ? { pollAfterMs: cancellation.pollAfterMs }
      : {}),
    reused: committed.reused && cancellation.reused,
  }
}

/**
 * Consumes only provider DTOs obtained after a trusted server-side webhook
 * verification/fetch. Unlike the browser callback verifier, this entry point
 * intentionally accepts no checkout signature and performs no provider read.
 */
export async function observeFutureSubscriptionAuthorization(
  unparsedInput: TrustedFutureSubscriptionAuthorizationObservationInput,
  dependencies: FutureSubscriptionAuthorizationDependencies = {},
): Promise<FutureSubscriptionAuthorizationVerificationResult> {
  const input = normalizeTrustedAuthorizationObservation(unparsedInput)
  const observedAt = dependencies.now?.() ?? new Date()
  if (!validDate(observedAt)) {
    throw failure('invalid_request', 'Authorization observation time is invalid')
  }
  const load = dependencies.loadContext ??
    defaultLoadFutureAuthorizationContext
  const context = await load({
    userId: input.userId,
    intentId: input.intentId,
  })
  if (!context) {
    throw failure('not_found', 'Future subscription checkout was not found')
  }
  assertExactFutureAuthorizationContext(
    context,
    input.userId,
    input.intentId,
  )
  return processFutureAuthorizationEvidence({
    ...input,
    context,
    observedAt,
    dependencies,
  })
}

async function loadTrustedSubscriptionCheckoutPurpose(input: {
  userId: string
  intentId: string
}): Promise<'acquisition' | 'replacement' | 'resubscribe' | null> {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    !OBJECT_ID_PATTERN.test(input.intentId)
  ) {
    return null
  }
  await connectDB()
  const intent = await CheckoutIntent.findOne({
    _id: new mongoose.Types.ObjectId(input.intentId),
    userId: new mongoose.Types.ObjectId(input.userId),
    kind: 'subscription',
  }).select('purpose').lean<{
    purpose?: 'acquisition' | 'replacement' | 'resubscribe'
  }>()
  return intent?.purpose ?? null
}

/**
 * Dispatches from immutable server-owned CheckoutIntent purpose. The browser
 * cannot route a ₹5 future authorization through captured-sale persistence.
 */
export async function verifyTrustedSubscriptionCheckout(
  input: FutureSubscriptionAuthorizationVerificationInput,
  dependencies:
  TrustedSubscriptionCheckoutVerificationDependencies = {},
): Promise<TrustedSubscriptionCheckoutVerificationResult> {
  const loadPurpose =
    dependencies.loadPurpose ??
    loadTrustedSubscriptionCheckoutPurpose
  const purpose = await loadPurpose({
    userId: input.userId,
    intentId: input.intentId,
  })
  if (!purpose) {
    throw failure('not_found', 'Subscription checkout was not found')
  }
  if (purpose === 'acquisition') {
    const verify = dependencies.verifyAcquisition ??
      verifyCapturedCheckout
    return {
      flow: 'acquisition',
      result: await verify({
        ...input,
        expectedKind: 'subscription',
      }),
    }
  }
  const verify = dependencies.verifyFuture ??
    verifyFutureSubscriptionAuthorization
  return {
    flow: 'future_authorization',
    result: await verify(input),
  }
}

interface ScheduledCancellationRequestRow {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  operation: PlanChangeRequestOperation
  fromPlanKey: 'free' | 'plus' | 'pro'
  toPlanKey: 'free' | 'plus' | 'pro'
  providerMode?: ProviderMode
  checkoutIntentId?: mongoose.Types.ObjectId
  fromSubscriptionId?: mongoose.Types.ObjectId
  toSubscriptionId?: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId?: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId?: string
  activeFenceKey?: string
  status: PlanChangeRequestStatus
  requestedAt: Date
  requestedEffectiveAt: Date
  authorizationExpiresAt?: Date
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAt?: Date
  oldCancellationAcceptedAt?: Date
  oldCancellationEffectiveAt?: Date
  replacementCancellationAcceptedAt?: Date
  replacementTerminalVerifiedAt?: Date
  outcome?: string
}

interface ScheduledCancellationContext {
  request: ScheduledCancellationRequestRow
  checkout: TrustedSubscriptionWebhookCheckout
  target: TrustedWebhookSubscription & {
    cancelAtPeriodEnd: boolean
    currentPeriodKey?: string
    currentPeriodStart?: Date
    currentPeriodEnd?: Date
  }
  oldSubscription: {
    _id: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    razorpaySubscriptionId: string
    status: SubscriptionStatus
    currentPeriodStart: Date
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
    scheduledPlanChange?: {
      targetPlanKey: 'plus' | 'pro'
      effectiveAt: Date
      requestedAt: Date
      source: 'customer' | 'admin'
      planChangeRequestId?: mongoose.Types.ObjectId
    }
  }
}

type ScheduledCancellationStart =
  | { terminal: true; result: CustomerScheduledPlanChangeCancellationResult }
  | { terminal: false; context: ScheduledCancellationContext }

export interface CustomerScheduledPlanChangeCancellationResult {
  planChangeRequestId: string
  status: 'cancelled' | 'reconciling' | 'review'
  effectiveAt: string
  reused: boolean
  pollAfterMs?: number
}

export interface CustomerScheduledPlanChangeCancellationDependencies {
  cancellationReady?: boolean
  now?: () => Date
  beginCompensation?: (input: {
    userId: string
    planChangeRequestId: string
    observedAt: Date
  }) => Promise<ScheduledCancellationStart>
  cancellationClientFactory?: RazorpaySubscriptionCancellationClientFactory
  persistTerminalObservation?: (
    input: SubscriptionProviderObservationInput,
    observedAt: Date,
  ) => Promise<SubscriptionStatePersistenceResult>
  finishCompensation?: (input: {
    context: ScheduledCancellationContext
    provider: RazorpaySubscriptionDto
    observedAt: Date
  }) => Promise<void>
  markUncertain?: (input: {
    context: ScheduledCancellationContext
    observedAt: Date
    review: boolean
    reason: string
    provider?: RazorpaySubscriptionDto
  }) => Promise<void>
}

function terminalReplacementStatus(
  status: string,
): status is 'cancelled' | 'completed' | 'expired' {
  return status === 'cancelled' ||
    status === 'completed' ||
    status === 'expired'
}

function exactScheduledCancellationLineage(input: {
  request: ScheduledCancellationRequestRow
  checkout: TrustedSubscriptionWebhookCheckout
  target: ScheduledCancellationContext['target']
  oldSubscription: ScheduledCancellationContext['oldSubscription']
  lease: {
    userId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    lane: ConsumerSubscriptionLeaseLane
    ownerCheckoutIntentId: mongoose.Types.ObjectId
    razorpaySubscriptionId?: string
    status: 'held' | 'release_pending' | 'released' | 'review'
    remoteTerminalVerifiedAt?: Date
    releasedAt?: Date
    releaseReason?: string
  }
  observedAt: Date
}): boolean {
  const { request, checkout, target, oldSubscription, lease } = input
  const controlLineage =
    classifyPlanChangeControlLineage(request)
  const mode = request.providerMode
  const userId = request.userId
  const expectedPurpose =
    request.operation === 'tier_change' ? 'replacement' : 'resubscribe'
  const localOpen = target.status === 'authenticated' &&
    checkout.status === 'authorization_pending' &&
    lease.status === 'held'
  const localTerminal = terminalReplacementStatus(target.status) &&
    checkout.status === 'cancelled' &&
    lease.status === 'released' &&
    lease.releaseReason === 'remote_terminal_verified' &&
    validDate(lease.remoteTerminalVerifiedAt) &&
    validDate(lease.releasedAt)
  const exactScheduledOld = request.operation === 'tier_change'
    ? Boolean(
        validDate(request.oldCancellationAcceptedAt) &&
        validDate(request.oldCancellationEffectiveAt) &&
        request.oldCancellationEffectiveAt?.getTime() ===
          request.requestedEffectiveAt.getTime() &&
        oldSubscription.scheduledPlanChange?.source ===
          request.source &&
        oldSubscription.scheduledPlanChange.targetPlanKey ===
          request.toPlanKey &&
        oldSubscription.scheduledPlanChange.effectiveAt.getTime() ===
          request.requestedEffectiveAt.getTime() &&
        oldSubscription.scheduledPlanChange.requestedAt.getTime() ===
          request.requestedAt.getTime() &&
        sameObjectId(
          oldSubscription.scheduledPlanChange.planChangeRequestId,
          request._id,
        ),
      )
    : oldSubscription.scheduledPlanChange === undefined
  return Boolean(
    (request.operation === 'tier_change' ||
      request.operation === 'resubscribe') &&
    controlLineage === 'customer' &&
    mode &&
    request.activeFenceKey === `${mode}:${userId.toHexString()}` &&
    ['scheduled', 'compensating', 'reconciling'].includes(request.status) &&
    (request.status !== 'scheduled' ||
      input.observedAt < request.requestedEffectiveAt) &&
    request.fromPlanKey !== 'free' &&
    request.toPlanKey !== 'free' &&
    request.checkoutIntentId?.equals(checkout._id) &&
    request.fromSubscriptionId?.equals(oldSubscription._id) &&
    request.toSubscriptionId?.equals(target._id) &&
    request.fromRazorpaySubscriptionId ===
      oldSubscription.razorpaySubscriptionId &&
    request.toRazorpaySubscriptionId === target.razorpaySubscriptionId &&
    request.targetRazorpayPlanId === target.razorpayPlanId &&
    validDate(request.replacementAuthorizedAt) &&
    PAYMENT_ID_PATTERN.test(
      request.replacementAuthorizationPaymentId ?? '',
    ) &&
    checkout.userId.equals(userId) &&
    checkout.providerMode === mode &&
    checkout.purpose === expectedPurpose &&
    checkout.planChangeRequestId?.equals(request._id) &&
    checkout.planKey === request.toPlanKey &&
    checkout.requestedStartAt?.getTime() ===
      request.requestedEffectiveAt.getTime() &&
    checkout.authorizationExpiresAt?.getTime() ===
      request.authorizationExpiresAt?.getTime() &&
    target.userId.equals(userId) &&
    target.providerMode === mode &&
    target.planKey === request.toPlanKey &&
    target.checkoutIntentId?.equals(checkout._id) &&
    target.planChangeRequestId?.equals(request._id) &&
    target.replacesSubscriptionId?.equals(oldSubscription._id) &&
    target.leaseLane === checkout.leaseLane &&
    target.currentPeriodKey === undefined &&
    target.currentPeriodStart === undefined &&
    target.currentPeriodEnd === undefined &&
    target.cancelAtPeriodEnd === false &&
    oldSubscription.userId.equals(userId) &&
    oldSubscription.providerMode === mode &&
    oldSubscription.currentPeriodEnd.getTime() ===
      request.requestedEffectiveAt.getTime() &&
    oldSubscription.cancelAtPeriodEnd &&
    exactScheduledOld &&
    lease.userId.equals(userId) &&
    lease.providerMode === mode &&
    lease.lane === checkout.leaseLane &&
    lease.ownerCheckoutIntentId.equals(checkout._id) &&
    lease.razorpaySubscriptionId === target.razorpaySubscriptionId &&
    (localOpen || localTerminal)
  )
}

async function beginScheduledCancellationMongo(input: {
  userId: string
  planChangeRequestId: string
  observedAt: Date
}): Promise<ScheduledCancellationStart> {
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const requestId = new mongoose.Types.ObjectId(input.planChangeRequestId)
  const session = await mongoose.startSession()
  let result: ScheduledCancellationStart | undefined
  try {
    await session.withTransaction(async () => {
      const request = await PlanChangeRequest.findOne({
        _id: requestId,
        userId,
      }).session(session).lean<ScheduledCancellationRequestRow>()
      if (!request) throw failure('not_found', 'Plan change was not found')
      const controlFilter = exactPlanChangeControlFilter(request)
      if (
        classifyPlanChangeControlLineage(request) !== 'customer' ||
        !controlFilter
      ) {
        throw failure(
          'lifecycle_conflict',
          'Scheduled cancellation control lineage is not customer-actionable',
        )
      }
      if (
        request.status === 'cancelled' &&
        (request.operation === 'tier_change' ||
          request.operation === 'resubscribe') &&
        request.outcome === 'cancelled' &&
        validDate(request.replacementCancellationAcceptedAt) &&
        validDate(request.replacementTerminalVerifiedAt)
      ) {
        result = {
          terminal: true,
          result: {
            planChangeRequestId: request._id.toHexString(),
            status: 'cancelled',
            effectiveAt: request.requestedEffectiveAt.toISOString(),
            reused: true,
          },
        }
        return
      }
      if (
        !request.checkoutIntentId ||
        !request.fromSubscriptionId ||
        !request.toSubscriptionId ||
        !request.providerMode
      ) {
        throw failure(
          'lifecycle_conflict',
          'Scheduled replacement cancellation lineage is incomplete',
        )
      }
      const checkout = await CheckoutIntent.findById(
        request.checkoutIntentId,
      ).session(session).lean<TrustedSubscriptionWebhookCheckout>()
      const target = await Subscription.findById(
        request.toSubscriptionId,
      ).session(session).lean<ScheduledCancellationContext['target']>()
      const oldSubscription = await Subscription.findById(
        request.fromSubscriptionId,
      ).session(session)
        .lean<ScheduledCancellationContext['oldSubscription']>()
      const lease = await ConsumerSubscriptionLease.findOne({
        userId,
        providerMode: request.providerMode,
        ownerCheckoutIntentId: request.checkoutIntentId,
      }).session(session).lean<{
        userId: mongoose.Types.ObjectId
        providerMode: ProviderMode
        lane: ConsumerSubscriptionLeaseLane
        ownerCheckoutIntentId: mongoose.Types.ObjectId
        razorpaySubscriptionId?: string
        status: 'held' | 'release_pending' | 'released' | 'review'
        remoteTerminalVerifiedAt?: Date
        releasedAt?: Date
        releaseReason?: string
      }>()
      if (
        !checkout ||
        !target ||
        !oldSubscription ||
        !lease ||
        !exactScheduledCancellationLineage({
          request,
          checkout,
          target,
          oldSubscription,
          lease,
          observedAt: input.observedAt,
        })
      ) {
        throw failure(
          'lifecycle_conflict',
          'Scheduled replacement cancellation lineage changed',
        )
      }
      const status = transitionPlanChangeStatus({
        operation: request.operation,
        currentStatus: request.status,
        event: { type: 'user_cancel_requested' },
      })
      const update = await PlanChangeRequest.updateOne(
        {
          _id: request._id,
          userId,
          ...controlFilter,
          operation: request.operation,
          providerMode: request.providerMode,
          checkoutIntentId: request.checkoutIntentId,
          fromSubscriptionId: request.fromSubscriptionId,
          toSubscriptionId: request.toSubscriptionId,
          fromRazorpaySubscriptionId:
            request.fromRazorpaySubscriptionId,
          toRazorpaySubscriptionId: request.toRazorpaySubscriptionId,
          activeFenceKey: request.activeFenceKey,
          status: request.status,
        },
        {
          $set: {
            status,
            nextRecoveryAt: new Date(
              input.observedAt.getTime() + RECOVERY_DELAY_MS,
            ),
            lastProviderObservedAt: input.observedAt,
            lastError: 'Customer requested replacement cancellation',
          },
          $inc: { attempts: 1 },
        },
        { session, runValidators: true },
      )
      if (update.matchedCount !== 1) {
        throw failure(
          'persistence_conflict',
          'Plan change moved before compensation was fenced',
        )
      }
      result = {
        terminal: false,
        context: { request, checkout, target, oldSubscription },
      }
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Cancellation compensation did not return a result',
    )
  }
  return result
}

function exactUnpaidReplacementProvider(
  context: ScheduledCancellationContext,
  provider: RazorpaySubscriptionDto,
): boolean {
  const boundary = Math.floor(
    context.request.requestedEffectiveAt.getTime() / 1_000,
  )
  return (
    provider.providerMode === context.request.providerMode &&
    provider.id === context.target.razorpaySubscriptionId &&
    provider.planId === context.target.razorpayPlanId &&
    provider.paidCount === 0 &&
    provider.startAtEpochSeconds === boundary &&
    (
      provider.chargeAtEpochSeconds === undefined ||
      provider.chargeAtEpochSeconds === boundary
    )
  )
}

async function finishScheduledCancellationMongo(input: {
  context: ScheduledCancellationContext
  provider: RazorpaySubscriptionDto
  observedAt: Date
}): Promise<void> {
  await connectDB()
  const { request, oldSubscription } = input.context
  const controlFilter = exactPlanChangeControlFilter(request)
  if (
    classifyPlanChangeControlLineage(request) !== 'customer' ||
    !controlFilter
  ) {
    throw failure(
      'lifecycle_conflict',
      'Scheduled cancellation control lineage is not customer-actionable',
    )
  }
  const targetPlanKey = request.toPlanKey
  if (targetPlanKey === 'free') {
    throw failure(
      'lifecycle_conflict',
      'Scheduled cancellation target must remain a paid tier',
    )
  }
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      if (request.operation === 'tier_change') {
        const oldUpdate = await Subscription.updateOne(
          {
            _id: oldSubscription._id,
            userId: request.userId,
            providerMode: request.providerMode,
            razorpaySubscriptionId:
              oldSubscription.razorpaySubscriptionId,
            cancelAtPeriodEnd: true,
            'scheduledPlanChange.planChangeRequestId': request._id,
            'scheduledPlanChange.targetPlanKey': targetPlanKey,
            'scheduledPlanChange.effectiveAt':
              request.requestedEffectiveAt,
            'scheduledPlanChange.requestedAt': request.requestedAt,
            'scheduledPlanChange.source': request.source,
          },
          { $unset: { scheduledPlanChange: 1 } },
          { session, runValidators: true },
        )
        if (oldUpdate.matchedCount !== 1) {
          throw failure(
            'persistence_conflict',
            'Old subscription schedule changed during compensation',
          )
        }
      } else {
        const oldStillEnding = await Subscription.exists({
          _id: oldSubscription._id,
          userId: request.userId,
          providerMode: request.providerMode,
          razorpaySubscriptionId:
            oldSubscription.razorpaySubscriptionId,
          cancelAtPeriodEnd: true,
          scheduledPlanChange: { $exists: false },
        }).session(session)
        if (!oldStillEnding) {
          throw failure(
            'persistence_conflict',
            'Old subscription no longer has the promised ending state',
          )
        }
      }
      const status = transitionPlanChangeStatus({
        operation: request.operation,
        currentStatus: 'compensating',
        event: {
          type: 'compensation_completed',
          outcome: 'cancelled',
          evidence: {
            cancellationAcceptedAt: input.observedAt,
            terminalVerifiedAt: input.observedAt,
          },
        },
      })
      const requestUpdate = await PlanChangeRequest.updateOne(
        {
          _id: request._id,
          userId: request.userId,
          ...controlFilter,
          operation: request.operation,
          providerMode: request.providerMode,
          checkoutIntentId: request.checkoutIntentId,
          fromSubscriptionId: request.fromSubscriptionId,
          toSubscriptionId: request.toSubscriptionId,
          fromRazorpaySubscriptionId:
            request.fromRazorpaySubscriptionId,
          toRazorpaySubscriptionId: request.toRazorpaySubscriptionId,
          activeFenceKey:
            `${request.providerMode}:${request.userId.toHexString()}`,
          status: 'compensating',
        },
        {
          $set: {
            status,
            replacementCancellationAcceptedAt: input.observedAt,
            replacementTerminalVerifiedAt: input.observedAt,
            lastProviderObservedAt: input.observedAt,
            providerSnapshot: {
              reason: 'customer_cancelled_scheduled_replacement',
              subscription: input.provider,
            },
            outcome: 'cancelled',
            outcomeAt: input.observedAt,
            outcomeReason:
              'Customer cancelled the future replacement subscription',
          },
          $unset: {
            activeFenceKey: 1,
            nextRecoveryAt: 1,
            lastError: 1,
          },
          $inc: { attempts: 1 },
        },
        { session, runValidators: true },
      )
      if (requestUpdate.matchedCount !== 1) {
        throw failure(
          'persistence_conflict',
          'Plan change moved before terminal compensation commit',
        )
      }
    }, TRANSACTION_OPTIONS)
  } finally {
    await session.endSession()
  }
}

async function markScheduledCancellationUncertainMongo(input: {
  context: ScheduledCancellationContext
  observedAt: Date
  review: boolean
  reason: string
  provider?: RazorpaySubscriptionDto
}): Promise<void> {
  await connectDB()
  const { request } = input.context
  const controlFilter = exactPlanChangeControlFilter(request)
  if (
    classifyPlanChangeControlLineage(request) !== 'customer' ||
    !controlFilter
  ) {
    throw failure(
      'lifecycle_conflict',
      'Scheduled cancellation control lineage is not customer-actionable',
    )
  }
  const status = transitionPlanChangeStatus({
    operation: request.operation,
    currentStatus: 'compensating',
    event: input.review
      ? { type: 'review_required' }
      : { type: 'provider_uncertain' },
  })
  const update = await PlanChangeRequest.updateOne(
    {
      _id: request._id,
      userId: request.userId,
      ...controlFilter,
      activeFenceKey:
        `${request.providerMode}:${request.userId.toHexString()}`,
      status: 'compensating',
    },
    {
      $set: {
        status,
        nextRecoveryAt: new Date(
          input.observedAt.getTime() + RECOVERY_DELAY_MS,
        ),
        lastProviderObservedAt: input.observedAt,
        lastError: input.reason.slice(0, 2_000),
        ...(input.provider
          ? { providerSnapshot: input.provider }
          : {}),
      },
      $inc: { attempts: 1 },
    },
    { runValidators: true },
  )
  if (update.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Compensation moved while scheduling recovery',
    )
  }
}

/**
 * Cancels only the immutable future replacement identified by the request ID.
 * The old subscription remains cancelled at period end and is never restored.
 */
export async function cancelCustomerScheduledPlanChange(
  input: {
    userId: string
    planChangeRequestId: string
  },
  dependencies:
  CustomerScheduledPlanChangeCancellationDependencies = {},
): Promise<CustomerScheduledPlanChangeCancellationResult> {
  if (
    !OBJECT_ID_PATTERN.test(input.userId) ||
    !OBJECT_ID_PATTERN.test(input.planChangeRequestId) ||
    !(dependencies.cancellationReady ??
      PR6_CUSTOMER_SCHEDULED_CHANGE_CANCELLATION_READY)
  ) {
    throw failure(
      'sale_blocked',
      'Scheduled replacement cancellation is disabled',
    )
  }
  const observedAt = dependencies.now?.() ?? new Date()
  if (!validDate(observedAt)) {
    throw failure('invalid_request', 'Cancellation time is invalid')
  }
  const begin =
    dependencies.beginCompensation ??
    beginScheduledCancellationMongo
  const started = await begin({ ...input, observedAt })
  if (started.terminal) return started.result
  const { context } = started
  const mark =
    dependencies.markUncertain ??
    markScheduledCancellationUncertainMongo
  const recover = async (
    review: boolean,
    reason: string,
    provider?: RazorpaySubscriptionDto,
  ): Promise<CustomerScheduledPlanChangeCancellationResult> => {
    await mark({ context, observedAt, review, reason, provider })
    return {
      planChangeRequestId: context.request._id.toHexString(),
      status: review ? 'review' : 'reconciling',
      effectiveAt: context.request.requestedEffectiveAt.toISOString(),
      reused: false,
      pollAfterMs: RECOVERY_DELAY_MS,
    }
  }
  const factory =
    dependencies.cancellationClientFactory ??
    defaultCancellationClientFactory()
  const client = factory.forMode(context.request.providerMode!)
  let provider: RazorpaySubscriptionDto
  try {
    provider = await client.fetchSubscription(
      context.target.razorpaySubscriptionId,
    )
  } catch {
    return recover(false, 'Provider state could not be read before cancellation')
  }
  if (!exactUnpaidReplacementProvider(context, provider)) {
    return recover(
      true,
      'Replacement provider evidence conflicts with immutable lineage',
      provider,
    )
  }
  if (!terminalReplacementStatus(provider.status)) {
    if (provider.status !== 'authenticated' &&
      provider.status !== 'created') {
      return recover(
        true,
        'Replacement is no longer safely cancellable before payment',
        provider,
      )
    }
    try {
      provider = await client.cancelSubscriptionImmediately(provider.id)
    } catch {
      return recover(
        false,
        'Provider cancellation result is ambiguous',
        provider,
      )
    }
  }
  if (
    !terminalReplacementStatus(provider.status) ||
    !exactUnpaidReplacementProvider(context, provider)
  ) {
    return recover(
      true,
      'Provider did not prove exact unpaid terminal replacement state',
      provider,
    )
  }
  const persist =
    dependencies.persistTerminalObservation ??
    ((observation, at) =>
      persistSubscriptionProviderObservation(observation, {
        now: () => at,
      }))
  let persisted: SubscriptionStatePersistenceResult
  try {
    persisted = await persist(
      {
        providerMode: context.request.providerMode!,
        razorpaySubscriptionId: provider.id,
        providerObservedAt: observedAt,
        subscription: provider,
        localContext: {
          checkout: context.checkout,
          subscription: context.target,
        },
      },
      observedAt,
    )
  } catch {
    return recover(
      false,
      'Terminal replacement evidence could not be persisted',
      provider,
    )
  }
  if (
    persisted.localSubscriptionId !== context.target._id.toHexString() ||
    persisted.subscriptionStatus !== provider.status ||
    persisted.checkoutIntentStatus !== 'cancelled' ||
    persisted.leaseStatus !== 'released'
  ) {
    return recover(
      true,
      'Terminal replacement persistence returned divergent state',
      provider,
    )
  }
  const finish =
    dependencies.finishCompensation ??
    finishScheduledCancellationMongo
  try {
    await finish({ context, provider, observedAt })
  } catch {
    return recover(
      false,
      'Terminal replacement state needs lifecycle reconciliation',
      provider,
    )
  }
  return {
    planChangeRequestId: context.request._id.toHexString(),
    status: 'cancelled',
    effectiveAt: context.request.requestedEffectiveAt.toISOString(),
    reused: false,
  }
}
