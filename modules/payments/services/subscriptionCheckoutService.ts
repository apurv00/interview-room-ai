import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import { inrPaise } from '../lib/money'
import {
  CheckoutIntent,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
  type ICheckoutQuoteSnapshot,
} from '../models/CheckoutIntent'
import type {
  ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import {
  CustomerBillingProfile,
  type ICustomerPlaceOfSupply,
} from '../models/CustomerBillingProfile'
import {
  CouponReservation,
  type CouponCapacityDisposition,
  type CouponReservationStatus,
} from '../models/CouponReservation'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import {
  PlanChangeRequest,
  classifyPlanChangeControlLineage,
  type PlanChangeAdminControlV1,
  type PlanChangeControlLineage,
  type PlanChangeRequestOperation,
  type PlanChangeRequestSource,
  type PlanChangeRequestStatus,
} from '../models/PlanChangeRequest'
import {
  Subscription,
  type SubscriptionStatus,
} from '../models/Subscription'
import {
  loadRazorpayApiCredentials,
} from '../providers/razorpayEnvironment'
import type {
  CouponCampaignMode,
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'
import {
  getBillingConfig,
} from './billingConfigService'
import {
  CheckoutCouponCapacityUnavailableError,
  CheckoutIntentIdempotencyConflictError,
  ConsumerSubscriptionCheckoutBlockedError,
  checkoutIntentRequestHash,
  createOrReuseCheckoutIntent,
  type CheckoutIntentCreationResult,
  type TrustedCheckoutIntentInput,
} from './checkoutIntentService'
import {
  CheckoutBlockedByAccountDeletionError,
} from './consumerBillingFenceService'
import {
  CustomerBillingQuoteUnavailableError,
  resolveCustomerBillingQuote,
  type ResolvedCustomerBillingQuote,
} from './customerBillingQuoteService'
import {
  CURRENT_PAYMENT_CODE_READINESS,
  evaluatePaymentSaleGate,
  type PaymentSaleBlockReason,
} from './paymentRuntimeGate'
import {
  createOrReuseRemoteCheckout,
  RemoteCheckoutCreationError,
  type RemoteCheckoutCreationDependencies,
  type RemoteCheckoutCreationResult,
  type TrustedRemoteCheckoutIntent,
  type TrustedSubscriptionCheckoutSpec,
} from './remoteCheckoutCreationService'
import {
  mongoSubscriptionCycleCommercialResolver,
  type OriginalSubscriptionCheckoutIntent,
  type ResolvedSubscriptionCommercialTerms,
  type SubscriptionCycleCommercialResolver,
} from './subscriptionCycleFulfillmentService'
import {
  CustomerPlaceOfSupplyInputSchema,
} from '../validators/customerBillingProfile'
import {
  CustomerBillingIdempotencyKeySchema,
} from '../validators/customerBilling'
import { CouponCodeSchema } from '../validators/coupon'
import {
  supersedeBlockingUnpaidSubscriptionCheckout,
  UnpaidSubscriptionCheckoutSupersessionError,
} from './unpaidSubscriptionCheckoutSupersessionService'
import {
  canAcceptInitialSubscriptionAcquisition,
  type SubscriptionAcquisitionUserAuthority,
} from './subscriptionAcquisitionAuthority'

// A 25-year monthly horizon keeps Razorpay-generated UPI mandate end dates
// within the provider's QR validation window while remaining effectively
// open-ended for a customer-cancelled subscription.
export const PROVISIONAL_SUBSCRIPTION_TOTAL_COUNT = 300 as const

export const SUBSCRIPTION_CHECKOUT_ERROR_CODES = [
  'invalid_request',
  'sale_blocked',
  'buyer_unavailable',
  'billing_profile_required',
  'commercial_unavailable',
  'idempotency_conflict',
  'subscription_conflict',
  'provider_unavailable',
  'review_required',
  'persistence_conflict',
] as const
export type SubscriptionCheckoutErrorCode =
  (typeof SUBSCRIPTION_CHECKOUT_ERROR_CODES)[number]

export class SubscriptionCheckoutError extends Error {
  constructor(
    readonly code: SubscriptionCheckoutErrorCode,
    message: string,
    options?: ErrorOptions & {
      saleBlockReason?: PaymentSaleBlockReason
    },
  ) {
    super(message, options)
    this.name = 'SubscriptionCheckoutError'
    this.saleBlockReason = options?.saleBlockReason
  }

  readonly saleBlockReason?: PaymentSaleBlockReason
}

export interface SubscriptionCheckoutInput {
  userId: string
  idempotencyKey: string
  request: {
    planKey: 'plus' | 'pro'
    manualCouponCode?: string
  }
}

export const MANDATE_AUTHORIZATION_AMOUNT_PAISE = 500 as const

/**
 * Browser-callable selection for an already-created lifecycle request.
 * Every lifecycle and economic field is reloaded from trusted persistence.
 */
export interface FutureSubscriptionCheckoutInput {
  userId: string
  planChangeRequestId: string
  idempotencyKey: string
  manualCouponCode?: string
}

export interface SubscriptionCheckoutSaleContext {
  providerMode: ProviderMode
  buyerSnapshot: Readonly<{
    name: string
    email: string
    billingProfileVersion: number
    billingProfileContentHash: string
    placeOfSupply: Readonly<ICustomerPlaceOfSupply>
  }>
}

export interface SubscriptionCheckoutQuote {
  catalogVersion: string
  planKey: 'plus' | 'pro'
  currency: 'INR'
  gstInclusive: true
  gstRatePercent: 18
  listPricePaise: number
  discountPaise: number
  payablePaise: number
  nextChargePaise: number
  renewalPricePaise: number
  discountedBillingCycles?: number
  coupon?: {
    campaignId: string
    revision: number
    mode: CouponCampaignMode
    code?: string
    displayText: string
    termsText: string
  }
  renewalSchedule: {
    cadence: 'monthly'
    status: 'pending_authorization'
    scheduledAt: null
  }
  disclosure: {
    summary: string
    why: string
    terms?: string
    gst: 'GST included.'
    cancellation: 'Auto-renews until cancelled.'
  }
  entitlementSummary: Readonly<Record<string, unknown>>
}

export interface SubscriptionCheckoutResult {
  intentId: string
  providerMode: ProviderMode
  intentStatus: 'remote_created'
  reused: boolean
  checkout: {
    keyId: string
    subscriptionId: string
  }
  quote: SubscriptionCheckoutQuote
}

export type FutureSubscriptionCheckoutQuote = Omit<
  SubscriptionCheckoutQuote,
  'renewalSchedule' | 'disclosure'
> & {
  mandateAuthorization: {
    amountPaise: typeof MANDATE_AUTHORIZATION_AMOUNT_PAISE
    currency: 'INR'
    captured: false
    entitlementEffect: 'none'
    disposition: 'razorpay_auto_refund'
  }
  firstPaidCycle: {
    amountPaise: number
    scheduledAt: string
  }
  renewalSchedule: {
    cadence: 'monthly'
    status: 'pending_authorization'
    scheduledAt: string
  }
  disclosure: SubscriptionCheckoutQuote['disclosure']
}

export interface FutureSubscriptionCheckoutResult
  extends Omit<SubscriptionCheckoutResult, 'quote'> {
  quote: FutureSubscriptionCheckoutQuote
}

export interface StoredSubscriptionCheckoutIntent
  extends OriginalSubscriptionCheckoutIntent {
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  receipt: string
  idempotencyKey: string
  requestHash: string
  buyerSnapshot: Readonly<Record<string, unknown>>
  couponReservation?: StoredSubscriptionCouponReservation
  quote: OriginalSubscriptionCheckoutIntent['quote'] & {
    subscriptionTotalCount?: number
    gst: ICheckoutQuoteSnapshot['gst']
    entitlementSnapshot: unknown
  }
}

export interface StoredSubscriptionCouponReservation {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot?: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  status: CouponReservationStatus
  capacityDisposition: CouponCapacityDisposition
  validUntil: Date
}

export interface SubscriptionCommercialPreflight {
  couponAccepted: boolean
}

export interface SubscriptionCheckoutDependencies {
  resolveSaleContext?: (
    userId: string,
  ) => Promise<SubscriptionCheckoutSaleContext>
  resolveQuote?: typeof resolveCustomerBillingQuote
  preflightQuote?: (
    resolved: ResolvedCustomerBillingQuote,
    providerMode: ProviderMode,
  ) => Promise<SubscriptionCommercialPreflight>
  createIntent?: typeof createOrReuseCheckoutIntent
  loadIntent?: (input: {
    intentId: string
    userId: string
  }) => Promise<StoredSubscriptionCheckoutIntent | null>
  commercialResolver?: SubscriptionCycleCommercialResolver
  createRemote?: typeof createOrReuseRemoteCheckout
  loadKeyId?: (providerMode: ProviderMode) => string
  supersedeBlockingCheckout?:
    typeof supersedeBlockingUnpaidSubscriptionCheckout
}

export interface InitialSubscriptionCheckoutDependencies
  extends SubscriptionCheckoutDependencies {
  loadAcquisitionAuthority?: (
    userId: string,
  ) => Promise<SubscriptionAcquisitionUserAuthority | null>
}

export interface FuturePlanChangeCheckoutEvidence {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  operation: PlanChangeRequestOperation
  fromPlanKey: 'free' | 'plus' | 'pro'
  toPlanKey: 'free' | 'plus' | 'pro'
  targetCatalogVersion: string
  requestedAt: Date
  requestedEffectiveAt: Date
  providerMode?: ProviderMode
  checkoutIntentId?: mongoose.Types.ObjectId
  fromSubscriptionId?: mongoose.Types.ObjectId
  toSubscriptionId?: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId?: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId?: string
  activeFenceKey?: string
  status: PlanChangeRequestStatus
  authorizationExpiresAt?: Date
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAt?: Date
}

export interface FutureCurrentSubscriptionEvidence {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  status: SubscriptionStatus
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAtPeriodEnd: boolean
  leaseLane?: ConsumerSubscriptionLeaseLane
}

export interface TrustedFutureSubscriptionCheckoutContext {
  userId: string
  actorUserId: string
  source: PlanChangeRequestSource
  controlLineage: PlanChangeControlLineage
  adminControl?: PlanChangeAdminControlV1
  planChangeRequestId: string
  checkoutIntentId: string
  fromSubscriptionId: string
  fromRazorpaySubscriptionId: string
  providerMode: ProviderMode
  purpose: 'replacement' | 'resubscribe'
  fromPlanKey: 'plus' | 'pro'
  targetPlanKey: 'plus' | 'pro'
  targetCatalogVersion: string
  targetRazorpayPlanId: string
  leaseLane: ConsumerSubscriptionLeaseLane
  requestedStartAt: Date
  authorizationExpiresAt: Date
}

export interface FutureSubscriptionCheckoutDependencies
  extends SubscriptionCheckoutDependencies {
  resolveFutureContext?: (input: {
    userId: string
    planChangeRequestId: string
    providerMode: ProviderMode
    now: Date
  }) => Promise<TrustedFutureSubscriptionCheckoutContext>
  now?: () => Date
}

interface LeanCatalogPreflight {
  version: string
  status: string
  effectiveAt?: Date
  contentHash: string
  content: {
    plans: {
      plus: {
        razorpayPlanIdByMode?: Partial<Record<ProviderMode, string>>
      }
      pro: {
        razorpayPlanIdByMode?: Partial<Record<ProviderMode, string>>
      }
    }
  }
  validation?: {
    contentHash: string
    errors: string[]
  }
  approval?: {
    contentHash: string
  }
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
}

interface LeanStoredCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'subscription'
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey: 'plus' | 'pro'
  catalogVersion: string
  idempotencyKey: string
  requestHash: string
  receipt: string
  quoteSnapshot: StoredSubscriptionCheckoutIntent['quote']
  buyerSnapshot: Readonly<Record<string, unknown>>
  razorpaySubscriptionId?: string
  createdAt: Date
}

interface LeanStoredCouponReservation
  extends StoredSubscriptionCouponReservation {}

interface CheckoutBuyerRow {
  name?: unknown
  email?: unknown
}

interface CheckoutBillingProfileRow {
  version?: unknown
  placeOfSupply?: unknown
  contentHash?: unknown
}

function failure(
  code: SubscriptionCheckoutErrorCode,
  message: string,
  options?: ErrorOptions & {
    saleBlockReason?: PaymentSaleBlockReason
  },
): SubscriptionCheckoutError {
  return new SubscriptionCheckoutError(code, message, options)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function providerSnapshotMatches(
  snapshot: ProviderVerificationSnapshot | undefined,
  contentHash: string,
): boolean {
  return Boolean(
    snapshot &&
    snapshot.status === 'verified' &&
    snapshot.normalizedTermsHash === contentHash &&
    snapshot.errors.length === 0,
  )
}

export function checkoutBuyerSnapshot(
  buyer: CheckoutBuyerRow,
  profile: CheckoutBillingProfileRow | null,
): SubscriptionCheckoutSaleContext['buyerSnapshot'] {
  if (
    typeof buyer.name !== 'string' ||
    buyer.name.trim().length === 0 ||
    typeof buyer.email !== 'string' ||
    buyer.email.trim().length === 0
  ) {
    throw failure('buyer_unavailable', 'Billing buyer details are unavailable')
  }
  if (!profile) {
    throw failure(
      'billing_profile_required',
      'A billing place of supply is required before checkout',
    )
  }

  const placeOfSupply = CustomerPlaceOfSupplyInputSchema.safeParse(
    profile.placeOfSupply,
  )
  const validVersion =
    typeof profile.version === 'number' &&
    Number.isSafeInteger(profile.version) &&
    profile.version >= 1
  const validHash =
    typeof profile.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(profile.contentHash) &&
    placeOfSupply.success &&
    sha256CanonicalJson({
      placeOfSupply: placeOfSupply.data,
    }) === profile.contentHash
  if (!validVersion || !validHash || !placeOfSupply.success) {
    throw failure(
      'persistence_conflict',
      'Billing profile integrity verification failed',
    )
  }

  return {
    name: buyer.name,
    email: buyer.email,
    billingProfileVersion: profile.version as number,
    billingProfileContentHash: profile.contentHash as string,
    placeOfSupply: structuredClone(placeOfSupply.data),
  }
}

async function defaultResolveSaleContext(
  userId: string,
): Promise<SubscriptionCheckoutSaleContext> {
  if (!mongoose.isValidObjectId(userId)) {
    throw failure('invalid_request', 'Authenticated user identifier is invalid')
  }
  if (!CURRENT_PAYMENT_CODE_READINESS.remoteCreationReady) {
    throw failure(
      'sale_blocked',
      'Subscription checkout is currently disabled',
      { saleBlockReason: 'remote_creation_not_ready' },
    )
  }

  const config = await getBillingConfig()
  const preliminary = evaluatePaymentSaleGate(
    config,
    userId,
    CURRENT_PAYMENT_CODE_READINESS,
  )
  if (!preliminary.allowed) {
    throw failure(
      'sale_blocked',
      'Subscription checkout is currently disabled',
      { saleBlockReason: preliminary.reason },
    )
  }

  await connectDB()
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const [buyer, billingProfile] = await Promise.all([
    User.findById(userObjectId)
      .select('name email buyerState')
      .lean<{
        name: string
        email: string
        buyerState?: string
      }>(),
    CustomerBillingProfile.findOne({ userId: userObjectId })
      .select('version placeOfSupply contentHash')
      .lean<CheckoutBillingProfileRow>(),
  ])
  if (!buyer) {
    throw failure('buyer_unavailable', 'Billing buyer was not found')
  }
  const finalGate = evaluatePaymentSaleGate(
    config,
    userId,
    CURRENT_PAYMENT_CODE_READINESS,
    buyer.buyerState,
  )
  if (!finalGate.allowed) {
    throw failure(
      'sale_blocked',
      'Subscription checkout is currently disabled',
      { saleBlockReason: finalGate.reason },
    )
  }
  if (finalGate.providerMode !== preliminary.providerMode) {
    throw failure(
      'persistence_conflict',
      'Subscription checkout provider mode changed during evaluation',
    )
  }
  const buyerSnapshot = checkoutBuyerSnapshot(buyer, billingProfile)
  return {
    providerMode: finalGate.providerMode,
    buyerSnapshot,
  }
}

/**
 * Read-only preflight for lifecycle orchestration. Calling this before a
 * PlanChange is persisted prevents an invalid buyer/profile or sale gate from
 * leaving a durable orphan.
 */
export async function resolveSubscriptionCheckoutSaleContext(
  userId: string,
): Promise<SubscriptionCheckoutSaleContext> {
  return defaultResolveSaleContext(userId)
}

function exactEpochSecond(value: unknown): value is Date {
  return (
    validDate(value) &&
    value.getMilliseconds() === 0
  )
}

function oppositeLeaseLane(
  lane: ConsumerSubscriptionLeaseLane,
): ConsumerSubscriptionLeaseLane {
  return lane === 'a' ? 'b' : 'a'
}

/**
 * Converts trusted Mongo evidence into the only lifecycle tuple that future
 * checkout may use. A browser-selected plan, price, lane, date, or provider
 * identifier never reaches this seam.
 */
export function deriveTrustedFutureSubscriptionCheckoutContext(input: {
  userId: string
  planChangeRequestId: string
  providerMode: ProviderMode
  now: Date
  planChange: FuturePlanChangeCheckoutEvidence | null
  currentSubscription: FutureCurrentSubscriptionEvidence | null
}): TrustedFutureSubscriptionCheckoutContext {
  if (
    !/^[a-fA-F0-9]{24}$/.test(input.userId) ||
    !/^[a-fA-F0-9]{24}$/.test(input.planChangeRequestId) ||
    !validDate(input.now)
  ) {
    throw failure(
      'invalid_request',
      'Future subscription checkout identifiers are invalid',
    )
  }

  const userId = new mongoose.Types.ObjectId(input.userId)
  const requestId =
    new mongoose.Types.ObjectId(input.planChangeRequestId)
  const request = input.planChange
  const current = input.currentSubscription
  const controlLineage = request
    ? classifyPlanChangeControlLineage(request)
    : undefined
  const purpose =
    request?.operation === 'tier_change'
      ? 'replacement'
      : request?.operation === 'resubscribe'
        ? 'resubscribe'
        : undefined
  const paidFromPlan =
    request?.fromPlanKey === 'plus' ||
    request?.fromPlanKey === 'pro'
  const paidTargetPlan =
    request?.toPlanKey === 'plus' ||
    request?.toPlanKey === 'pro'
  const operationPlansMatch = Boolean(
    purpose === 'replacement'
      ? request?.fromPlanKey !== request?.toPlanKey
      : purpose === 'resubscribe'
        ? request?.fromPlanKey === request?.toPlanKey
        : false,
  )
  const currentCancellationMatches = Boolean(
    purpose === 'replacement'
      ? current?.cancelAtPeriodEnd === false
      : purpose === 'resubscribe'
        ? current?.cancelAtPeriodEnd === true
        : false,
  )
  const exactFence =
    `${input.providerMode}:${userId.toHexString()}`

  if (
    !request ||
    !current ||
    !request._id.equals(requestId) ||
    !request.userId.equals(userId) ||
    controlLineage !== 'customer' ||
    request.status !== 'authorization_pending' ||
    request.providerMode !== input.providerMode ||
    request.activeFenceKey !== exactFence ||
    !purpose ||
    !paidFromPlan ||
    !paidTargetPlan ||
    !operationPlansMatch ||
    !request.checkoutIntentId ||
    !request.fromSubscriptionId ||
    !request.fromRazorpaySubscriptionId ||
    !/^sub_[A-Za-z0-9]+$/.test(
      request.fromRazorpaySubscriptionId,
    ) ||
    !request.targetRazorpayPlanId ||
    !/^plan_[A-Za-z0-9]+$/.test(request.targetRazorpayPlanId) ||
    request.targetCatalogVersion.trim().length === 0 ||
    !validDate(request.requestedAt) ||
    !exactEpochSecond(request.requestedEffectiveAt) ||
    !exactEpochSecond(request.authorizationExpiresAt) ||
    request.authorizationExpiresAt <= request.requestedAt ||
    request.authorizationExpiresAt >= request.requestedEffectiveAt ||
    request.authorizationExpiresAt <= input.now ||
    request.requestedEffectiveAt <= input.now ||
    request.replacementAuthorizationPaymentId !== undefined ||
    request.replacementAuthorizedAt !== undefined ||
    !current._id.equals(request.fromSubscriptionId) ||
    !current.userId.equals(userId) ||
    current.providerMode !== input.providerMode ||
    current.planKey !== request.fromPlanKey ||
    current.razorpaySubscriptionId !==
      request.fromRazorpaySubscriptionId ||
    current.status !== 'active' ||
    !exactEpochSecond(current.currentPeriodStart) ||
    !exactEpochSecond(current.currentPeriodEnd) ||
    current.currentPeriodStart >= current.currentPeriodEnd ||
    current.currentPeriodStart > input.now ||
    current.currentPeriodEnd.getTime() !==
      request.requestedEffectiveAt.getTime() ||
    !current.leaseLane ||
    !currentCancellationMatches
  ) {
    throw failure(
      'persistence_conflict',
      'Durable future subscription checkout context is inconsistent',
    )
  }

  return {
    userId: userId.toHexString(),
    actorUserId: request.actorUserId.toHexString(),
    source: request.source,
    controlLineage,
    planChangeRequestId: requestId.toHexString(),
    checkoutIntentId: request.checkoutIntentId.toHexString(),
    fromSubscriptionId: current._id.toHexString(),
    fromRazorpaySubscriptionId:
      current.razorpaySubscriptionId,
    providerMode: input.providerMode,
    purpose,
    fromPlanKey: request.fromPlanKey as 'plus' | 'pro',
    targetPlanKey: request.toPlanKey as 'plus' | 'pro',
    targetCatalogVersion: request.targetCatalogVersion,
    targetRazorpayPlanId: request.targetRazorpayPlanId,
    leaseLane: oppositeLeaseLane(current.leaseLane),
    requestedStartAt: new Date(request.requestedEffectiveAt),
    authorizationExpiresAt:
      new Date(request.authorizationExpiresAt),
  }
}

async function defaultResolveFutureContext(input: {
  userId: string
  planChangeRequestId: string
  providerMode: ProviderMode
  now: Date
}): Promise<TrustedFutureSubscriptionCheckoutContext> {
  if (
    !/^[a-fA-F0-9]{24}$/.test(input.userId) ||
    !/^[a-fA-F0-9]{24}$/.test(input.planChangeRequestId)
  ) {
    throw failure(
      'invalid_request',
      'Future subscription checkout identifiers are invalid',
    )
  }
  await connectDB()
  const userId = new mongoose.Types.ObjectId(input.userId)
  const planChangeRequestId =
    new mongoose.Types.ObjectId(input.planChangeRequestId)
  const planChange = await PlanChangeRequest.findOne({
    _id: planChangeRequestId,
    userId,
  }).select([
    '_id',
    'userId',
    'actorUserId',
    'source',
    'adminControl',
    'operation',
    'fromPlanKey',
    'toPlanKey',
    'targetCatalogVersion',
    'requestedAt',
    'requestedEffectiveAt',
    'providerMode',
    'checkoutIntentId',
    'fromSubscriptionId',
    'toSubscriptionId',
    'fromRazorpaySubscriptionId',
    'toRazorpaySubscriptionId',
    'targetRazorpayPlanId',
    'activeFenceKey',
    'status',
    'authorizationExpiresAt',
    'replacementAuthorizationPaymentId',
    'replacementAuthorizedAt',
  ].join(' ')).lean<FuturePlanChangeCheckoutEvidence>()
  const currentSubscription = planChange?.fromSubscriptionId
    ? await Subscription.findOne({
        _id: planChange.fromSubscriptionId,
        userId,
      }).select([
        '_id',
        'userId',
        'providerMode',
        'planKey',
        'razorpaySubscriptionId',
        'status',
        'currentPeriodStart',
        'currentPeriodEnd',
        'cancelAtPeriodEnd',
        'leaseLane',
      ].join(' ')).lean<FutureCurrentSubscriptionEvidence>()
    : null
  return deriveTrustedFutureSubscriptionCheckoutContext({
    ...input,
    planChange: planChange ?? null,
    currentSubscription: currentSubscription ?? null,
  })
}

function exactSelectedCoupon(
  resolved: ResolvedCustomerBillingQuote,
  providerMode: ProviderMode,
): boolean {
  const selected = resolved.selectedCandidate
  const quote = resolved.quote
  if (!selected) return quote.discountPaise === 0 && !quote.coupon
  const verification = selected.providerVerification?.[providerMode]
  return (
    selected.status === 'active' &&
    selected.availability.providerMode === providerMode &&
    quote.coupon?.campaignId === selected.campaignId &&
    quote.coupon.revision === selected.revision &&
    quote.discountPaise === selected.terms.discountPaise &&
    quote.discountedBillingCycles ===
      selected.terms.discountedBillingCycles &&
    selected.terms.discountedBillingCycles === 1 &&
    selected.terms.eligibility.upgradesEligible === false &&
    providerSnapshotMatches(verification, selected.contentHash)
  )
}

async function defaultPreflightQuote(
  resolved: ResolvedCustomerBillingQuote,
  providerMode: ProviderMode,
): Promise<SubscriptionCommercialPreflight> {
  const planKey = resolved.quote.planKey
  if (
    (planKey !== 'plus' && planKey !== 'pro') ||
    resolved.providerMode !== providerMode
  ) {
    throw failure(
      'commercial_unavailable',
      'Published subscription pricing is unavailable',
    )
  }
  await connectDB()
  const catalog = await PlanCatalogVersion.findOne({
    version: resolved.catalog.version,
    status: 'published',
  }).select([
    'version',
    'status',
    'effectiveAt',
    'content',
    'contentHash',
    'validation',
    'approval',
    'providerVerification',
  ].join(' ')).lean<LeanCatalogPreflight>()
  const planId =
    catalog?.content.plans[planKey].razorpayPlanIdByMode?.[providerMode]
  if (
    !catalog ||
    catalog.version !== resolved.quote.catalogVersion ||
    catalog.contentHash !== resolved.catalog.contentHash ||
    catalog.validation?.contentHash !== catalog.contentHash ||
    catalog.validation.errors.length > 0 ||
    catalog.approval?.contentHash !== catalog.contentHash ||
    !providerSnapshotMatches(
      catalog.providerVerification?.[providerMode],
      catalog.contentHash,
    ) ||
    typeof planId !== 'string' ||
    !/^plan_[A-Za-z0-9]+$/.test(planId)
  ) {
    throw failure(
      'commercial_unavailable',
      'Published Razorpay Plan binding is unavailable',
    )
  }
  return {
    couponAccepted: exactSelectedCoupon(resolved, providerMode),
  }
}

function toStoredIntent(
  intent: LeanStoredCheckoutIntent,
  couponReservation?: LeanStoredCouponReservation,
): StoredSubscriptionCheckoutIntent {
  return {
    id: intent._id,
    userId: intent.userId,
    kind: intent.kind,
    providerMode: intent.providerMode,
    status: intent.status,
    purpose: intent.purpose,
    planChangeRequestId: intent.planChangeRequestId,
    leaseLane: intent.leaseLane,
    requestedStartAt: intent.requestedStartAt,
    authorizationExpiresAt: intent.authorizationExpiresAt,
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    idempotencyKey: intent.idempotencyKey,
    requestHash: intent.requestHash,
    receipt: intent.receipt,
    quote: intent.quoteSnapshot,
    buyerSnapshot: intent.buyerSnapshot,
    couponReservation,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    createdAt: intent.createdAt,
  }
}

async function defaultLoadIntent(input: {
  intentId: string
  userId: string
}): Promise<StoredSubscriptionCheckoutIntent | null> {
  if (
    !mongoose.isValidObjectId(input.intentId) ||
    !mongoose.isValidObjectId(input.userId)
  ) return null
  await connectDB()
  const checkoutIntentId = new mongoose.Types.ObjectId(input.intentId)
  const userId = new mongoose.Types.ObjectId(input.userId)
  const [intent, couponReservation] = await Promise.all([
    CheckoutIntent.findOne({
      _id: checkoutIntentId,
      userId,
      kind: 'subscription',
    }).select([
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
      'idempotencyKey',
      'requestHash',
      'receipt',
      'quoteSnapshot',
      'buyerSnapshot',
      'razorpaySubscriptionId',
      'createdAt',
    ].join(' ')).lean<LeanStoredCheckoutIntent>(),
    CouponReservation.findOne({
      checkoutIntentId,
    }).select([
      'providerMode',
      'campaignId',
      'campaignRevision',
      'userId',
      'checkoutIntentId',
      'catalogVersion',
      'planKey',
      'campaignModeSnapshot',
      'codeSnapshot',
      'discountPaise',
      'discountedBillingCycles',
      'status',
      'capacityDisposition',
      'validUntil',
    ].join(' ')).lean<LeanStoredCouponReservation>(),
  ])
  return intent
    ? toStoredIntent(intent, couponReservation ?? undefined)
    : null
}

function quoteSnapshot(
  resolved: ResolvedCustomerBillingQuote,
  useCoupon: boolean,
): ICheckoutQuoteSnapshot {
  const quote = resolved.quote
  const selected = useCoupon ? resolved.selectedCandidate : undefined
  return {
    currency: 'INR',
    listPricePaise: inrPaise(quote.listPricePaise),
    discountPaise: inrPaise(selected?.terms.discountPaise ?? 0),
    payablePaise: inrPaise(
      quote.listPricePaise - (selected?.terms.discountPaise ?? 0),
    ),
    renewalPricePaise: inrPaise(quote.listPricePaise),
    subscriptionTotalCount: PROVISIONAL_SUBSCRIPTION_TOTAL_COUNT,
    ...(selected
      ? {
          discountedBillingCycles:
            selected.terms.discountedBillingCycles,
          couponCampaignId:
            new mongoose.Types.ObjectId(selected.campaignId),
          couponCampaignRevision: selected.revision,
        }
      : {}),
    gst: {
      inclusive: true,
      rateBps: 1_800,
      componentAllocation: 'unallocated',
    },
    entitlementSnapshot: quote.entitlementSummary,
  }
}

function trustedIntentInput(input: {
  checkout: SubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  resolved: ResolvedCustomerBillingQuote
  useCoupon: boolean
}): TrustedCheckoutIntentInput {
  const { checkout, sale, resolved, useCoupon } = input
  const selected = useCoupon ? resolved.selectedCandidate : undefined
  return {
    userId: checkout.userId,
    kind: 'subscription',
    providerMode: sale.providerMode,
    purpose: 'acquisition',
    leaseLane: 'a',
    planKey: checkout.request.planKey,
    manualCouponCode: checkout.request.manualCouponCode,
    catalogVersion: resolved.quote.catalogVersion,
    idempotencyKey: checkout.idempotencyKey,
    quoteSnapshot: quoteSnapshot(resolved, useCoupon),
    buyerSnapshot: sale.buyerSnapshot,
    ...(selected
      ? {
          couponReservation: {
            campaignId: selected.campaignId,
            campaignRevision: selected.revision,
            campaignModeSnapshot: selected.mode,
            ...(selected.mode === 'code' && selected.code
              ? { codeSnapshot: selected.code }
              : {}),
            discountPaise: selected.terms.discountPaise,
            discountedBillingCycles:
              selected.terms.discountedBillingCycles,
            maxRedemptions: selected.terms.maxRedemptions,
            maxRedemptionsPerUser:
              selected.terms.maxRedemptionsPerUser,
            reservationTtlHours:
              selected.terms.reservationTtlHours,
          },
        }
      : {}),
  }
}

async function createTrustedIntent(input: {
  checkout: SubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  resolved: ResolvedCustomerBillingQuote
  useCoupon: boolean
  createIntent: typeof createOrReuseCheckoutIntent
}): Promise<CheckoutIntentCreationResult> {
  return input.createIntent(trustedIntentInput(input))
}

function trustedFutureIntentInput(input: {
  checkout: FutureSubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  lifecycle: TrustedFutureSubscriptionCheckoutContext
  resolved: ResolvedCustomerBillingQuote
  useCoupon: boolean
}): TrustedCheckoutIntentInput {
  const {
    checkout,
    sale,
    lifecycle,
    resolved,
    useCoupon,
  } = input
  const selected = useCoupon ? resolved.selectedCandidate : undefined
  return {
    userId: checkout.userId,
    kind: 'subscription',
    providerMode: lifecycle.providerMode,
    preallocatedIntentId: lifecycle.checkoutIntentId,
    purpose: lifecycle.purpose,
    planChangeRequestId: lifecycle.planChangeRequestId,
    leaseLane: lifecycle.leaseLane,
    requestedStartAt: lifecycle.requestedStartAt,
    authorizationExpiresAt: lifecycle.authorizationExpiresAt,
    planKey: lifecycle.targetPlanKey,
    manualCouponCode: checkout.manualCouponCode,
    catalogVersion: lifecycle.targetCatalogVersion,
    idempotencyKey: checkout.idempotencyKey,
    quoteSnapshot: quoteSnapshot(resolved, useCoupon),
    buyerSnapshot: sale.buyerSnapshot,
    ...(selected
      ? {
          couponReservation: {
            campaignId: selected.campaignId,
            campaignRevision: selected.revision,
            campaignModeSnapshot: selected.mode,
            ...(selected.mode === 'code' && selected.code
              ? { codeSnapshot: selected.code }
              : {}),
            discountPaise: selected.terms.discountPaise,
            discountedBillingCycles:
              selected.terms.discountedBillingCycles,
            maxRedemptions: selected.terms.maxRedemptions,
            maxRedemptionsPerUser:
              selected.terms.maxRedemptionsPerUser,
            reservationTtlHours:
              selected.terms.reservationTtlHours,
          },
        }
      : {}),
  }
}

async function createTrustedFutureIntent(input: {
  checkout: FutureSubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  lifecycle: TrustedFutureSubscriptionCheckoutContext
  resolved: ResolvedCustomerBillingQuote
  useCoupon: boolean
  createIntent: typeof createOrReuseCheckoutIntent
}): Promise<CheckoutIntentCreationResult> {
  return input.createIntent(trustedFutureIntentInput(input))
}

function normalizeFutureCheckoutInput(
  input: FutureSubscriptionCheckoutInput,
): FutureSubscriptionCheckoutInput {
  try {
    return {
      userId: input.userId,
      planChangeRequestId: input.planChangeRequestId,
      idempotencyKey:
        CustomerBillingIdempotencyKeySchema.parse(
          input.idempotencyKey,
        ),
      ...(input.manualCouponCode !== undefined
        ? {
            manualCouponCode:
              CouponCodeSchema.parse(input.manualCouponCode),
          }
        : {}),
    }
  } catch {
    throw failure(
      'invalid_request',
      'Future subscription checkout selection is invalid',
    )
  }
}

function assertFutureRetrySelection(input: {
  checkout: FutureSubscriptionCheckoutInput
  lifecycle: TrustedFutureSubscriptionCheckoutContext
  stored: StoredSubscriptionCheckoutIntent
}): void {
  const { checkout, lifecycle, stored } = input
  const reservation = stored.couponReservation
  const discounted = stored.quote.discountPaise > 0
  const subscriptionTotalCount =
    stored.quote.subscriptionTotalCount
  if (
    stored.idempotencyKey !== checkout.idempotencyKey ||
    !validSubscriptionTotalCount(subscriptionTotalCount) ||
    (
      discounted &&
      (
        !reservation ||
        (
          reservation.campaignModeSnapshot !== 'automatic' &&
          reservation.campaignModeSnapshot !== 'code' &&
          reservation.campaignModeSnapshot !== 'targeted'
        )
      )
    )
  ) {
    throw failure(
      'idempotency_conflict',
      'Idempotency-Key belongs to a different future checkout',
    )
  }
  const retryQuote: ICheckoutQuoteSnapshot = {
    currency: 'INR',
    listPricePaise: inrPaise(stored.quote.listPricePaise),
    discountPaise: inrPaise(stored.quote.discountPaise),
    payablePaise: inrPaise(stored.quote.payablePaise),
    renewalPricePaise: inrPaise(stored.quote.renewalPricePaise!),
    subscriptionTotalCount,
    ...(stored.quote.discountedBillingCycles !== undefined
      ? {
          discountedBillingCycles:
            stored.quote.discountedBillingCycles,
        }
      : {}),
    ...(stored.quote.couponCampaignId
      ? { couponCampaignId: stored.quote.couponCampaignId }
      : {}),
    ...(stored.quote.couponCampaignRevision !== undefined
      ? {
          couponCampaignRevision:
            stored.quote.couponCampaignRevision,
        }
      : {}),
    gst: stored.quote.gst,
    entitlementSnapshot: stored.quote.entitlementSnapshot,
  }
  const expectedHash = checkoutIntentRequestHash({
    userId: lifecycle.userId,
    kind: 'subscription',
    providerMode: lifecycle.providerMode,
    preallocatedIntentId: lifecycle.checkoutIntentId,
    purpose: lifecycle.purpose,
    planChangeRequestId: lifecycle.planChangeRequestId,
    leaseLane: lifecycle.leaseLane,
    requestedStartAt: lifecycle.requestedStartAt,
    authorizationExpiresAt: lifecycle.authorizationExpiresAt,
    planKey: lifecycle.targetPlanKey,
    manualCouponCode: checkout.manualCouponCode,
    catalogVersion: stored.catalogVersion,
    idempotencyKey: checkout.idempotencyKey,
    quoteSnapshot: retryQuote,
    buyerSnapshot: stored.buyerSnapshot,
    ...(discounted && reservation
      ? {
          couponReservation: {
            campaignId: reservation.campaignId.toHexString(),
            campaignRevision: reservation.campaignRevision,
            campaignModeSnapshot:
              reservation.campaignModeSnapshot!,
            ...(reservation.codeSnapshot
              ? { codeSnapshot: reservation.codeSnapshot }
              : {}),
            discountPaise: reservation.discountPaise,
            discountedBillingCycles:
              reservation.discountedBillingCycles,
            maxRedemptionsPerUser: 1,
            reservationTtlHours: 1,
          },
        }
      : {}),
  })
  if (expectedHash !== stored.requestHash) {
    throw failure(
      'idempotency_conflict',
      'Idempotency-Key belongs to a different future checkout',
    )
  }
}

function sameObjectId(
  left: mongoose.Types.ObjectId | undefined,
  right: mongoose.Types.ObjectId | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function validSubscriptionTotalCount(
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function trustedSubscriptionSpec(
  intent: StoredSubscriptionCheckoutIntent,
  terms: ResolvedSubscriptionCommercialTerms,
): TrustedSubscriptionCheckoutSpec {
  const plan = terms.catalog.plan
  const quote = intent.quote
  const totalCount = quote.subscriptionTotalCount
  const futureStartAt = exactEpochSecond(intent.requestedStartAt)
    ? intent.requestedStartAt
    : undefined
  const acquisitionLifecycle = (
    intent.purpose === 'acquisition' &&
    intent.planChangeRequestId === undefined &&
    intent.leaseLane === 'a' &&
    (
      quote.discountPaise === 0
        ? intent.requestedStartAt === undefined
        : (
            futureStartAt !== undefined &&
            futureStartAt > intent.authorizationExpiresAt! &&
            futureStartAt > intent.createdAt
          )
    )
  )
  const futureLifecycle = (
    (
      intent.purpose === 'replacement' ||
      intent.purpose === 'resubscribe'
    ) &&
    intent.planChangeRequestId instanceof mongoose.Types.ObjectId &&
    (
      intent.leaseLane === 'a' ||
      intent.leaseLane === 'b'
    ) &&
    futureStartAt !== undefined &&
    futureStartAt > intent.createdAt
  )
  const authorizationExpiresAtEpochSeconds =
    intent.authorizationExpiresAt
      ? Math.floor(intent.authorizationExpiresAt.getTime() / 1_000)
      : undefined
  const startAtEpochSeconds = futureLifecycle || quote.discountPaise > 0
    ? Math.floor(futureStartAt!.getTime() / 1_000)
    : undefined
  if (
    intent.kind !== 'subscription' ||
    (!acquisitionLifecycle && !futureLifecycle) ||
    !validDate(intent.authorizationExpiresAt) ||
    intent.authorizationExpiresAt.getMilliseconds() !== 0 ||
    intent.authorizationExpiresAt <= intent.createdAt ||
    (
      futureLifecycle &&
      intent.authorizationExpiresAt >= futureStartAt!
    ) ||
    authorizationExpiresAtEpochSeconds === undefined ||
    (intent.planKey !== 'plus' && intent.planKey !== 'pro') ||
    !validDate(intent.createdAt) ||
    terms.catalog.version !== intent.catalogVersion ||
    terms.catalog.status === 'draft' ||
    terms.catalog.status === 'scheduled' ||
    !terms.catalog.integrityVerified ||
    (terms.catalog.effectiveAt &&
      terms.catalog.effectiveAt > intent.createdAt) ||
    (terms.catalog.publishedAt &&
      terms.catalog.publishedAt > intent.createdAt) ||
    plan.key !== intent.planKey ||
    plan.billingPeriod !== 'monthly' ||
    plan.interviewPeriodOwner !== 'razorpay_billing_cycle' ||
    plan.listPricePaise !== quote.listPricePaise ||
    quote.renewalPricePaise !== plan.listPricePaise ||
    !validSubscriptionTotalCount(totalCount) ||
    typeof plan.razorpayPlanId !== 'string' ||
    !/^plan_[A-Za-z0-9]+$/.test(plan.razorpayPlanId) ||
    quote.payablePaise !== quote.listPricePaise - quote.discountPaise ||
    quote.payablePaise <= 0
  ) {
    throw failure(
      'commercial_unavailable',
      'Immutable subscription Plan terms are inconsistent',
    )
  }

  if (quote.discountPaise === 0) {
    if (
      terms.coupon ||
      intent.couponReservation ||
      quote.couponCampaignId ||
      quote.couponCampaignRevision !== undefined ||
      quote.discountedBillingCycles !== undefined
    ) {
      throw failure(
        'commercial_unavailable',
        'Non-coupon checkout contains coupon terms',
      )
    }
    return {
      planKey: intent.planKey,
      razorpayPlanId: plan.razorpayPlanId,
      totalCount,
      purpose: intent.purpose!,
      ...(futureLifecycle
        ? {
            planChangeRequestId:
              intent.planChangeRequestId!.toHexString(),
            startAtEpochSeconds,
          }
        : {}),
      leaseLane: intent.leaseLane!,
      authorizationExpiresAtEpochSeconds,
    }
  }

  const coupon = terms.coupon
  const reservation = intent.couponReservation
  const reservationMode = reservation?.campaignModeSnapshot
  const reservationCode = reservation?.codeSnapshot?.trim().toUpperCase()
  const validReservationMode =
    reservationMode === 'automatic' ||
    reservationMode === 'code' ||
    reservationMode === 'targeted'
  const validReservationCode =
    reservationMode === 'code'
      ? typeof reservationCode === 'string' &&
        reservationCode.length >= 3 &&
        reservationCode.length <= 40 &&
        /^[A-Z0-9][A-Z0-9_-]*$/.test(reservationCode)
      : reservationCode === undefined
  const hasAttachedRemote =
    intent.razorpaySubscriptionId !== undefined
  const validAttachedRemote =
    !hasAttachedRemote ||
    (
      typeof intent.razorpaySubscriptionId === 'string' &&
      /^sub_[A-Za-z0-9]+$/.test(intent.razorpaySubscriptionId)
    )
  const validReservationState =
    ['reserved', 'converted', 'released', 'expired', 'review']
      .includes(reservation?.status ?? '') &&
    ['held', 'converted', 'released']
      .includes(reservation?.capacityDisposition ?? '') &&
    validDate(reservation?.validUntil)
  const validReservationForFirstRemote =
    hasAttachedRemote ||
    (
      reservation?.status === 'reserved' &&
      reservation.capacityDisposition === 'held' &&
      validDate(reservation.validUntil) &&
      reservation.validUntil.getTime() > Date.now()
    )
  if (
    !coupon ||
    !reservation ||
    !quote.couponCampaignId ||
    quote.couponCampaignRevision === undefined ||
    quote.discountedBillingCycles === undefined ||
    !validReservationMode ||
    !validReservationCode ||
    !validAttachedRemote ||
    !validReservationState ||
    !validReservationForFirstRemote ||
    reservation.providerMode !== intent.providerMode ||
    !sameObjectId(reservation.campaignId, quote.couponCampaignId) ||
    reservation.campaignRevision !== quote.couponCampaignRevision ||
    !reservation.userId.equals(intent.userId) ||
    !reservation.checkoutIntentId.equals(intent.id) ||
    reservation.catalogVersion !== intent.catalogVersion ||
    reservation.planKey !== intent.planKey ||
    reservation.discountPaise !== quote.discountPaise ||
    reservation.discountedBillingCycles !==
      quote.discountedBillingCycles ||
    !sameObjectId(coupon.campaignId, quote.couponCampaignId) ||
    coupon.revision !== quote.couponCampaignRevision ||
    coupon.status === 'draft' ||
    coupon.status === 'scheduled' ||
    !coupon.integrityVerified ||
    coupon.discountPaise !== quote.discountPaise ||
    coupon.discountedBillingCycles !==
      quote.discountedBillingCycles ||
    !coupon.applicablePlanKeys.includes(intent.planKey) ||
    coupon.discountedBillingCycles !== 1 ||
    intent.purpose !== 'acquisition' ||
    startAtEpochSeconds === undefined ||
    (coupon.startsAt && coupon.startsAt > intent.createdAt) ||
    (coupon.endsAt && coupon.endsAt <= intent.createdAt) ||
    typeof coupon.termsText !== 'string' ||
    coupon.termsText.trim().length < 10 ||
    coupon.termsText.trim().length > 2_000 ||
    (coupon.bannerText !== undefined &&
      (typeof coupon.bannerText !== 'string' ||
        coupon.bannerText.trim().length < 1 ||
        coupon.bannerText.trim().length > 300)) ||
    coupon.discountedBillingCycles > totalCount
  ) {
    throw failure(
      'commercial_unavailable',
      'Immutable subscription coupon terms are inconsistent',
    )
  }
  return {
    planKey: intent.planKey,
    razorpayPlanId: plan.razorpayPlanId,
    upfrontAmountPaise: quote.payablePaise,
    upfrontItemName:
      `${intent.planKey === 'plus' ? 'Plus' : 'Pro'} first month`,
    totalCount,
    purpose: intent.purpose!,
    ...(futureLifecycle
      ? {
          planChangeRequestId:
            intent.planChangeRequestId!.toHexString(),
          startAtEpochSeconds,
        }
      : quote.discountPaise > 0
        ? { startAtEpochSeconds }
      : {}),
    leaseLane: intent.leaseLane!,
    authorizationExpiresAtEpochSeconds,
  }
}

function assertRemoteIntentMatches(
  remote: TrustedRemoteCheckoutIntent,
  stored: StoredSubscriptionCheckoutIntent,
): void {
  if (
    !remote._id.equals(stored.id) ||
    !remote.userId.equals(stored.userId) ||
    remote.kind !== 'subscription' ||
    remote.providerMode !== stored.providerMode ||
    remote.purpose !== stored.purpose ||
    remote.planChangeRequestId?.toString() !==
      stored.planChangeRequestId?.toString() ||
    remote.leaseLane !== stored.leaseLane ||
    remote.requestedStartAt?.getTime() !==
      stored.requestedStartAt?.getTime() ||
    remote.authorizationExpiresAt?.getTime() !==
      stored.authorizationExpiresAt?.getTime() ||
    remote.planKey !== stored.planKey ||
    remote.catalogVersion !== stored.catalogVersion ||
    remote.receipt !== stored.receipt ||
    remote.payablePaise !== stored.quote.payablePaise ||
    remote.discountPaise !== stored.quote.discountPaise ||
    remote.discountedBillingCycles !==
      stored.quote.discountedBillingCycles
  ) {
    throw failure(
      'persistence_conflict',
      'Remote checkout loader returned a different commercial intent',
    )
  }
}

function assertFutureStoredIntentMatches(
  stored: StoredSubscriptionCheckoutIntent,
  lifecycle: TrustedFutureSubscriptionCheckoutContext,
): void {
  if (
    stored.id.toHexString() !== lifecycle.checkoutIntentId ||
    stored.userId.toHexString() !== lifecycle.userId ||
    stored.providerMode !== lifecycle.providerMode ||
    stored.purpose !== lifecycle.purpose ||
    stored.planChangeRequestId?.toHexString() !==
      lifecycle.planChangeRequestId ||
    stored.leaseLane !== lifecycle.leaseLane ||
    stored.requestedStartAt?.getTime() !==
      lifecycle.requestedStartAt.getTime() ||
    stored.authorizationExpiresAt?.getTime() !==
      lifecycle.authorizationExpiresAt.getTime() ||
    stored.planKey !== lifecycle.targetPlanKey ||
    stored.catalogVersion !== lifecycle.targetCatalogVersion
  ) {
    throw failure(
      'persistence_conflict',
      'Stored checkout intent does not match its durable plan change',
    )
  }
}

function amount(paise: number): string {
  const rupees = paise / 100
  return `₹${Number.isInteger(rupees) ? rupees : rupees.toFixed(2)}`
}

function entitlementSnapshot(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
}

function publicQuote(
  intent: StoredSubscriptionCheckoutIntent,
  terms: ResolvedSubscriptionCommercialTerms,
): SubscriptionCheckoutQuote {
  const quote = intent.quote
  const cycles = quote.discountedBillingCycles
  const coupon = terms.coupon
  const reservation = intent.couponReservation
  const discounted = quote.discountPaise > 0 && cycles !== undefined
  const summary = discounted
    ? cycles === 1
      ? `${amount(quote.payablePaise)} for the first billing month, then ` +
        `${amount(quote.renewalPricePaise!)}/month. ` +
        'Auto-renews until cancelled.'
      : `${amount(quote.payablePaise)} for the first ${cycles} billing ` +
        `months, then ${amount(quote.renewalPricePaise!)}/month. ` +
        'Auto-renews until cancelled.'
    : `${amount(quote.listPricePaise)}/month. Auto-renews until cancelled.`
  return {
    catalogVersion: intent.catalogVersion,
    planKey: intent.planKey as 'plus' | 'pro',
    currency: 'INR',
    gstInclusive: true,
    gstRatePercent: 18,
    listPricePaise: quote.listPricePaise,
    discountPaise: quote.discountPaise,
    payablePaise: quote.payablePaise,
    nextChargePaise:
      discounted && (cycles ?? 0) > 1
        ? quote.payablePaise
        : quote.renewalPricePaise!,
    renewalPricePaise: quote.renewalPricePaise!,
    ...(discounted
      ? {
          discountedBillingCycles: cycles,
          coupon: {
            campaignId: coupon!.campaignId.toString(),
            revision: coupon!.revision,
            mode: reservation!.campaignModeSnapshot!,
            ...(reservation!.campaignModeSnapshot === 'code'
              ? { code: reservation!.codeSnapshot!.trim().toUpperCase() }
              : {}),
            displayText:
              coupon!.bannerText?.trim() ||
              `${amount(quote.discountPaise)} off`,
            termsText: coupon!.termsText.trim(),
          },
        }
      : {}),
    renewalSchedule: {
      cadence: 'monthly',
      status: 'pending_authorization',
      scheduledAt: null,
    },
    disclosure: {
      summary: `${summary} GST included.`,
      why: discounted
        ? reservation!.campaignModeSnapshot === 'code'
          ? `Coupon code ${reservation!.codeSnapshot!
              .trim()
              .toUpperCase()} applied.`
          : reservation!.campaignModeSnapshot === 'targeted'
            ? 'Eligible targeted offer applied.'
            : 'Best eligible automatic offer applied.'
        : 'No eligible coupon is applied.',
      ...(discounted
        ? {
            terms: coupon!.termsText.trim(),
          }
        : {}),
      gst: 'GST included.',
      cancellation: 'Auto-renews until cancelled.',
    },
    entitlementSummary: entitlementSnapshot(
      quote.entitlementSnapshot,
    ),
  }
}

function publicFutureQuote(
  intent: StoredSubscriptionCheckoutIntent,
  terms: ResolvedSubscriptionCommercialTerms,
): FutureSubscriptionCheckoutQuote {
  if (
    (
      intent.purpose !== 'replacement' &&
      intent.purpose !== 'resubscribe'
    ) ||
    !exactEpochSecond(intent.requestedStartAt)
  ) {
    throw failure(
      'persistence_conflict',
      'Future checkout disclosure has no exact effective time',
    )
  }
  const quote = publicQuote(intent, terms)
  const scheduledAt = intent.requestedStartAt.toISOString()
  const displayName =
    intent.planKey === 'pro' ? 'Pro' : 'Plus'
  return {
    ...quote,
    mandateAuthorization: {
      amountPaise: MANDATE_AUTHORIZATION_AMOUNT_PAISE,
      currency: 'INR',
      captured: false,
      entitlementEffect: 'none',
      disposition: 'razorpay_auto_refund',
    },
    firstPaidCycle: {
      amountPaise: quote.payablePaise,
      scheduledAt,
    },
    renewalSchedule: {
      cadence: 'monthly',
      status: 'pending_authorization',
      scheduledAt,
    },
    disclosure: {
      ...quote.disclosure,
      summary:
        `A refundable ₹5 Razorpay mandate authorization is separate ` +
        `from plan billing, is not captured as a plan payment, and ` +
        `grants no paid access. The first paid ${displayName} cycle ` +
        `of ${amount(quote.payablePaise)} starts at ${scheduledAt}. ` +
        quote.disclosure.summary,
    },
  }
}

function assertFutureContextMatchesRequest(input: {
  checkout: FutureSubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  lifecycle: TrustedFutureSubscriptionCheckoutContext
  now: Date
}): void {
  const { checkout, sale, lifecycle, now } = input
  const planPairMatches =
    lifecycle.purpose === 'replacement'
      ? lifecycle.fromPlanKey !== lifecycle.targetPlanKey
      : lifecycle.purpose === 'resubscribe' &&
        lifecycle.fromPlanKey === lifecycle.targetPlanKey
  if (
    lifecycle.userId !== checkout.userId.toLowerCase() ||
    lifecycle.planChangeRequestId !==
      checkout.planChangeRequestId.toLowerCase() ||
    lifecycle.providerMode !== sale.providerMode ||
    !/^[a-f0-9]{24}$/.test(lifecycle.checkoutIntentId) ||
    !/^[a-f0-9]{24}$/.test(lifecycle.fromSubscriptionId) ||
    !/^sub_[A-Za-z0-9]+$/.test(
      lifecycle.fromRazorpaySubscriptionId,
    ) ||
    !/^plan_[A-Za-z0-9]+$/.test(lifecycle.targetRazorpayPlanId) ||
    lifecycle.targetCatalogVersion.trim().length === 0 ||
    !planPairMatches ||
    (
      lifecycle.leaseLane !== 'a' &&
      lifecycle.leaseLane !== 'b'
    ) ||
    !exactEpochSecond(lifecycle.requestedStartAt) ||
    !exactEpochSecond(lifecycle.authorizationExpiresAt) ||
    lifecycle.authorizationExpiresAt <= now ||
    lifecycle.authorizationExpiresAt >=
      lifecycle.requestedStartAt
  ) {
    throw failure(
      'persistence_conflict',
      'Future checkout loader returned inconsistent durable context',
    )
  }
}

async function completeFutureSubscriptionCheckout(input: {
  checkout: FutureSubscriptionCheckoutInput
  sale: SubscriptionCheckoutSaleContext
  lifecycle: TrustedFutureSubscriptionCheckoutContext
  stored: StoredSubscriptionCheckoutIntent
  localReused: boolean
  dependencies: FutureSubscriptionCheckoutDependencies
}): Promise<FutureSubscriptionCheckoutResult> {
  const {
    checkout,
    sale,
    lifecycle,
    stored,
    dependencies,
  } = input
  assertFutureStoredIntentMatches(stored, lifecycle)
  assertFutureRetrySelection({
    checkout,
    lifecycle,
    stored,
  })

  const resolver =
    dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver
  const terms = await resolver.resolve(stored)
  if (
    !terms ||
    terms.catalog.plan.razorpayPlanId !==
      lifecycle.targetRazorpayPlanId
  ) {
    throw failure(
      'commercial_unavailable',
      'Pinned replacement subscription terms were not found',
    )
  }
  const spec = trustedSubscriptionSpec(stored, terms)
  const checkoutQuote = publicFutureQuote(stored, terms)
  const createRemote =
    dependencies.createRemote ?? createOrReuseRemoteCheckout
  const remoteDependencies: RemoteCheckoutCreationDependencies = {
    resolveSubscriptionSpec: async (remoteIntent) => {
      assertRemoteIntentMatches(remoteIntent, stored)
      return spec
    },
  }
  const remote = await createRemote(
    {
      userId: checkout.userId,
      intentId: lifecycle.checkoutIntentId,
    },
    remoteDependencies,
  )
  if (
    remote.kind !== 'subscription' ||
    remote.providerMode !== sale.providerMode ||
    remote.intentId !== lifecycle.checkoutIntentId
  ) {
    throw failure(
      'persistence_conflict',
      'Remote future subscription result has the wrong lifecycle',
    )
  }
  const loadKeyId = dependencies.loadKeyId ??
    ((mode: ProviderMode) => loadRazorpayApiCredentials(mode).keyId)
  return {
    intentId: lifecycle.checkoutIntentId,
    providerMode: lifecycle.providerMode,
    intentStatus: 'remote_created',
    reused: input.localReused || remote.reused,
    checkout: {
      keyId: loadKeyId(lifecycle.providerMode),
      subscriptionId: remote.remoteId,
    },
    quote: checkoutQuote,
  }
}

function mapKnownFailure(error: unknown): never {
  if (error instanceof SubscriptionCheckoutError) throw error
  if (error instanceof CheckoutIntentIdempotencyConflictError) {
    throw failure(
      'idempotency_conflict',
      'Idempotency-Key belongs to a different checkout selection',
    )
  }
  if (error instanceof ConsumerSubscriptionCheckoutBlockedError) {
    throw failure(
      'subscription_conflict',
      'An existing subscription checkout requires reconciliation',
    )
  }
  if (error instanceof CheckoutBlockedByAccountDeletionError) {
    throw failure(
      'sale_blocked',
      'Checkout is unavailable while account deletion is pending',
      { saleBlockReason: 'buyer_deletion_pending' },
    )
  }
  if (error instanceof CustomerBillingQuoteUnavailableError) {
    throw failure(
      error.code === 'buyer_unavailable'
        ? 'buyer_unavailable'
        : 'commercial_unavailable',
      'Subscription pricing is temporarily unavailable',
    )
  }
  if (error instanceof RemoteCheckoutCreationError) {
    if (error.code === 'sale_blocked') {
      throw failure(
        'sale_blocked',
        'Subscription checkout is currently disabled',
        { saleBlockReason: error.saleBlockReason },
      )
    }
    if (
      error.code === 'remote_mismatch' ||
      error.code === 'reconciliation_conflict' ||
      error.code === 'persistence_conflict'
    ) {
      throw failure(
        'review_required',
        'Subscription checkout requires reconciliation',
      )
    }
    if (error.code === 'subscription_spec_unavailable') {
      throw failure(
        'commercial_unavailable',
        'Subscription Plan or Offer is unavailable',
      )
    }
    if (error.code === 'provider_unavailable') {
      throw failure(
        'provider_unavailable',
        'Razorpay checkout is temporarily unavailable',
      )
    }
  }
  throw failure(
    'persistence_conflict',
    'Subscription checkout could not be created coherently',
  )
}

async function reopenBlockingSubscriptionCheckout(input: {
  userId: string
  planKey: 'plus' | 'pro'
  intentId: string
  requestStartedAt: Date
  sale: SubscriptionCheckoutSaleContext
  dependencies: SubscriptionCheckoutDependencies
}): Promise<SubscriptionCheckoutResult> {
  const loadIntent = input.dependencies.loadIntent ?? defaultLoadIntent
  const stored = await loadIntent({
    intentId: input.intentId,
    userId: input.userId,
  })
  if (
    !stored ||
    stored.id.toHexString() !== input.intentId ||
    stored.userId.toHexString() !== input.userId ||
    stored.providerMode !== input.sale.providerMode ||
    stored.status !== 'remote_created' ||
    stored.purpose !== 'acquisition' ||
    stored.leaseLane !== 'a' ||
    stored.planKey !== input.planKey ||
    stored.quote.subscriptionTotalCount !==
      PROVISIONAL_SUBSCRIPTION_TOTAL_COUNT ||
    !validDate(stored.authorizationExpiresAt) ||
    stored.authorizationExpiresAt <= input.requestStartedAt ||
    !stored.razorpaySubscriptionId
  ) {
    throw failure(
      'review_required',
      'The existing subscription checkout cannot be reopened safely',
    )
  }

  const resolver = input.dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver
  const terms = await resolver.resolve(stored)
  if (!terms) {
    throw failure(
      'commercial_unavailable',
      'Immutable subscription terms were not found',
    )
  }
  const spec = trustedSubscriptionSpec(stored, terms)
  const checkoutQuote = publicQuote(stored, terms)
  const createRemote = input.dependencies.createRemote ??
    createOrReuseRemoteCheckout
  const remote = await createRemote(
    { userId: input.userId, intentId: input.intentId },
    {
      resolveSubscriptionSpec: async (remoteIntent) => {
        assertRemoteIntentMatches(remoteIntent, stored)
        return spec
      },
    },
  )
  if (
    remote.kind !== 'subscription' ||
    remote.providerMode !== input.sale.providerMode ||
    remote.intentId !== input.intentId ||
    remote.remoteId !== stored.razorpaySubscriptionId
  ) {
    throw failure(
      'persistence_conflict',
      'Recovered subscription checkout has the wrong durable lineage',
    )
  }
  const loadKeyId = input.dependencies.loadKeyId ??
    ((mode: ProviderMode) => loadRazorpayApiCredentials(mode).keyId)
  return {
    intentId: input.intentId,
    providerMode: input.sale.providerMode,
    intentStatus: 'remote_created',
    reused: true,
    checkout: {
      keyId: loadKeyId(input.sale.providerMode),
      subscriptionId: remote.remoteId,
    },
    quote: checkoutQuote,
  }
}

/**
 * Authenticated subscription checkout orchestration. The browser supplies
 * only plan/manual-code/idempotency selection; all prices, entitlements,
 * provider mode, Plan/Offer IDs, capacity, and buyer state are server-owned.
 *
 * CURRENT_PAYMENT_CODE_READINESS keeps the default path inert before any
 * local intent, reservation, credential read, or Razorpay call.
 */
export async function createSubscriptionCheckout(
  input: SubscriptionCheckoutInput,
  dependencies: InitialSubscriptionCheckoutDependencies = {},
): Promise<SubscriptionCheckoutResult> {
  const requestStartedAt = new Date()
  let effectiveIdempotencyKey = input.idempotencyKey
  try {
    const resolveSale =
      dependencies.resolveSaleContext ?? defaultResolveSaleContext
    const sale = await resolveSale(input.userId)
    const loadAcquisitionAuthority =
      dependencies.loadAcquisitionAuthority ?? (async (userId: string) => {
        if (!mongoose.isValidObjectId(userId)) return null
        await connectDB()
        return User.findById(new mongoose.Types.ObjectId(userId))
          .select([
            'plan',
            'planVocabularyVersion',
            'planExpiresAt',
            'entitlementSource',
            'usagePeriodKey',
            'interviewsUsed',
            'interviewLimit',
            'premiumResumesUsed',
            'premiumResumeLimit',
            'entitlementVersion',
            'buyerState',
            'accountState',
            'role',
            'organizationId',
          ].join(' '))
          .lean<SubscriptionAcquisitionUserAuthority>()
      })
    const acquisitionAuthority =
      await loadAcquisitionAuthority(input.userId)
    if (!acquisitionAuthority) {
      throw failure('buyer_unavailable', 'Billing buyer was not found')
    }
    if (!canAcceptInitialSubscriptionAcquisition(acquisitionAuthority)) {
      throw failure(
        'review_required',
        'Account billing state requires review before subscription checkout',
      )
    }
    const supersedeBlockingCheckout =
      dependencies.supersedeBlockingCheckout ??
      supersedeBlockingUnpaidSubscriptionCheckout
    try {
      const blockingCheckout = await supersedeBlockingCheckout({
        userId: input.userId,
        providerMode: sale.providerMode,
        replacementPlanKey: input.request.planKey,
        expectedSubscriptionTotalCount:
          PROVISIONAL_SUBSCRIPTION_TOTAL_COUNT,
        requestStartedAt,
      })
      if (blockingCheckout.outcome === 'reusable') {
        return await reopenBlockingSubscriptionCheckout({
          userId: input.userId,
          planKey: input.request.planKey,
          intentId: blockingCheckout.intentId,
          requestStartedAt,
          sale,
          dependencies,
        })
      }
      if (blockingCheckout.outcome === 'superseded') {
        effectiveIdempotencyKey = [
          'billing-subscription',
          'superseded',
          blockingCheckout.intentId,
          PROVISIONAL_SUBSCRIPTION_TOTAL_COUNT,
        ].join(':')
      }
    } catch (error) {
      if (error instanceof UnpaidSubscriptionCheckoutSupersessionError) {
        throw failure(
          error.code,
          error.code === 'provider_unavailable'
            ? 'The existing Razorpay checkout could not be verified'
            : 'The existing subscription checkout requires reconciliation',
          { cause: error },
        )
      }
      throw error
    }
    const resolveQuote =
      dependencies.resolveQuote ?? resolveCustomerBillingQuote
    const resolved = await resolveQuote({
      userId: input.userId,
      request: {
        planKey: input.request.planKey,
        surface: 'checkout',
        manualCouponCode: input.request.manualCouponCode,
      },
    })
    if (
      resolved.providerMode !== sale.providerMode ||
      resolved.quote.planKey !== input.request.planKey
    ) {
      throw failure(
        'commercial_unavailable',
        'Checkout pricing does not match the sale mode',
      )
    }

    const preflight =
      dependencies.preflightQuote ?? defaultPreflightQuote
    const commercial = await preflight(
      resolved,
      sale.providerMode,
    )
    const useCoupon = Boolean(
      resolved.selectedCandidate && commercial.couponAccepted,
    )
    const createIntent =
      dependencies.createIntent ?? createOrReuseCheckoutIntent
    let local: CheckoutIntentCreationResult
    try {
      local = await createTrustedIntent({
        checkout: {
          ...input,
          idempotencyKey: effectiveIdempotencyKey,
        },
        sale,
        resolved,
        useCoupon,
        createIntent,
      })
    } catch (error) {
      if (!(error instanceof CheckoutCouponCapacityUnavailableError)) {
        throw error
      }
      throw failure(
        'commercial_unavailable',
        'The launch discount is temporarily unavailable',
      )
    }

    const loadIntent = dependencies.loadIntent ?? defaultLoadIntent
    const stored = await loadIntent({
      intentId: local.intentId,
      userId: input.userId,
    })
    if (
      !stored ||
      stored.providerMode !== sale.providerMode ||
      stored.planKey !== input.request.planKey ||
      stored.requestHash !== local.requestHash
    ) {
      throw failure(
        'persistence_conflict',
        'Created checkout intent could not be reloaded exactly',
      )
    }

    const resolver =
      dependencies.commercialResolver ??
      mongoSubscriptionCycleCommercialResolver
    const terms = await resolver.resolve(stored)
    if (!terms) {
      throw failure(
        'commercial_unavailable',
        'Immutable subscription terms were not found',
      )
    }
    const spec = trustedSubscriptionSpec(stored, terms)
    const checkoutQuote = publicQuote(stored, terms)
    const createRemote =
      dependencies.createRemote ?? createOrReuseRemoteCheckout
    const remoteDependencies: RemoteCheckoutCreationDependencies = {
      resolveSubscriptionSpec: async (remoteIntent) => {
        assertRemoteIntentMatches(remoteIntent, stored)
        return spec
      },
    }
    const remote: RemoteCheckoutCreationResult = await createRemote(
      {
        userId: input.userId,
        intentId: local.intentId,
      },
      remoteDependencies,
    )
    if (
      remote.kind !== 'subscription' ||
      remote.providerMode !== sale.providerMode
    ) {
      throw failure(
        'persistence_conflict',
        'Remote subscription result has the wrong checkout mode',
      )
    }
    const loadKeyId = dependencies.loadKeyId ??
      ((mode: ProviderMode) => loadRazorpayApiCredentials(mode).keyId)
    const keyId = loadKeyId(sale.providerMode)
    return {
      intentId: local.intentId,
      providerMode: sale.providerMode,
      intentStatus: 'remote_created',
      reused: local.reused || remote.reused,
      checkout: {
        keyId,
        subscriptionId: remote.remoteId,
      },
      quote: checkoutQuote,
    }
  } catch (error) {
    return mapKnownFailure(error)
  }
}

/**
 * Creates or reopens the Razorpay authorization for a durable next-boundary
 * tier change/resubscribe request. The authenticated browser names only that
 * request and its retry selection; plan, catalog, provider Plan, lease lane,
 * start time, and authorization deadline are derived from trusted state.
 */
export async function createFutureSubscriptionCheckout(
  unparsedInput: FutureSubscriptionCheckoutInput,
  dependencies: FutureSubscriptionCheckoutDependencies = {},
): Promise<FutureSubscriptionCheckoutResult> {
  try {
    const input = normalizeFutureCheckoutInput(unparsedInput)
    const resolveSale =
      dependencies.resolveSaleContext ?? defaultResolveSaleContext
    const sale = await resolveSale(input.userId)
    const nowProvider = dependencies.now ?? (() => new Date())
    const now = nowProvider()
    if (!validDate(now)) {
      throw failure('invalid_request', 'Current time is invalid')
    }
    const resolveFuture =
      dependencies.resolveFutureContext ??
      defaultResolveFutureContext
    const lifecycle = await resolveFuture({
      userId: input.userId,
      planChangeRequestId: input.planChangeRequestId,
      providerMode: sale.providerMode,
      now,
    })
    assertFutureContextMatchesRequest({
      checkout: input,
      sale,
      lifecycle,
      now,
    })

    const loadIntent = dependencies.loadIntent ?? defaultLoadIntent
    const existing = await loadIntent({
      intentId: lifecycle.checkoutIntentId,
      userId: input.userId,
    })
    if (existing) {
      return await completeFutureSubscriptionCheckout({
        checkout: input,
        sale,
        lifecycle,
        stored: existing,
        localReused: true,
        dependencies,
      })
    }

    const resolveQuote =
      dependencies.resolveQuote ?? resolveCustomerBillingQuote
    const resolved = await resolveQuote({
      userId: input.userId,
      request: {
        planKey: lifecycle.targetPlanKey,
        surface: 'checkout',
        manualCouponCode: input.manualCouponCode,
      },
    })
    if (
      resolved.providerMode !== lifecycle.providerMode ||
      resolved.quote.planKey !== lifecycle.targetPlanKey ||
      resolved.quote.catalogVersion !==
        lifecycle.targetCatalogVersion
    ) {
      throw failure(
        'commercial_unavailable',
        'Pinned future subscription pricing is unavailable',
      )
    }

    const preflight =
      dependencies.preflightQuote ?? defaultPreflightQuote
    const commercial = await preflight(
      resolved,
      lifecycle.providerMode,
    )
    const resolvedTargetPlanId =
      resolved.catalog.content.plans[
        lifecycle.targetPlanKey
      ].razorpayPlanIdByMode?.[lifecycle.providerMode]
    if (resolvedTargetPlanId !== lifecycle.targetRazorpayPlanId) {
      throw failure(
        'commercial_unavailable',
        'Pinned Razorpay Plan does not match the target catalog',
      )
    }
    const useCoupon = Boolean(
      resolved.selectedCandidate && commercial.couponAccepted,
    )
    const createIntent =
      dependencies.createIntent ?? createOrReuseCheckoutIntent
    let local: CheckoutIntentCreationResult
    try {
      local = await createTrustedFutureIntent({
        checkout: input,
        sale,
        lifecycle,
        resolved,
        useCoupon,
        createIntent,
      })
    } catch (error) {
      if (!(error instanceof CheckoutCouponCapacityUnavailableError)) {
        throw error
      }
      throw failure(
        'commercial_unavailable',
        'The launch discount is temporarily unavailable',
      )
    }
    if (local.intentId !== lifecycle.checkoutIntentId) {
      throw failure(
        'persistence_conflict',
        'Future checkout used an unexpected local intent identity',
      )
    }

    const stored = await loadIntent({
      intentId: lifecycle.checkoutIntentId,
      userId: input.userId,
    })
    if (
      !stored ||
      stored.requestHash !== local.requestHash
    ) {
      throw failure(
        'persistence_conflict',
        'Future checkout intent could not be reloaded exactly',
      )
    }
    return await completeFutureSubscriptionCheckout({
      checkout: input,
      sale,
      lifecycle,
      stored,
      localReused: local.reused,
      dependencies,
    })
  } catch (error) {
    return mapKnownFailure(error)
  }
}
