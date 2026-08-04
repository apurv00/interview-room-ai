import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User, type IUser } from '@shared/db/models/User'
import { CURRENT_PLAN_VOCABULARY_VERSION } from '@shared/services/planConfig'
import { canonicalJson } from '../lib/canonicalJson'
import { isInrPaise } from '../lib/money'
import {
  ChargeFulfillment,
  type ChargeFulfillmentStatus,
  type IChargeFulfillmentSteps,
} from '../models/ChargeFulfillment'
import {
  CheckoutIntent,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import type {
  ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import { CouponCampaignRevision } from '../models/CouponCampaignRevision'
import { PaymentAttempt } from '../models/PaymentAttempt'
import {
  PlanChangeRequest,
  classifyPlanChangeControlLineage,
  exactPlanChangeControlFilter,
  type PlanChangeAdminControlV1,
  type PlanChangeRequestOperation,
  type PlanChangeRequestSource,
  type PlanChangeRequestStatus,
} from '../models/PlanChangeRequest'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import {
  Subscription,
  type SubscriptionStatus,
} from '../models/Subscription'
import {
  SubscriptionCycle,
  type SubscriptionCycleProjectionDisposition,
} from '../models/SubscriptionCycle'
import {
  RazorpayInvoiceDtoSchema,
  RazorpayPaymentDtoSchema,
  RazorpaySubscriptionDtoSchema,
  type RazorpayInvoiceDto,
  type RazorpayPaymentDto,
  type RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type {
  CatalogContent,
  CatalogStatus,
  CouponPolicyApprovalKind,
  CouponPolicyApprovalSnapshot,
  CouponRevisionStatus,
  CouponValidationSnapshot,
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'
import type {
  SubscriptionChargedWebhookReferences,
} from './webhookReferenceParser'
import { paidBillingPeriod } from './periodKeyService'
import {
  convertCouponReservationCycleInSession,
} from './couponReservationService'
import {
  commitUserEntitlementProjectionUpdateInSession,
} from './entitlementService'
import {
  arbitrateSubscriptionCycleProjection,
  type ProjectionCheckoutEvidence,
  type ProjectionPlanChangeEvidence,
  type ProjectionSubscriptionEvidence,
  type RecordedProjectionDisposition,
  type SubscriptionProjectionDecision,
  type UserSubscriptionProjectionEvidence,
} from './subscriptionProjectionArbiter'
import { transitionPlanChangeStatus } from './planChangeTransitionKernel'

const EXPECTED_INTERVIEW_LIMIT = {
  plus: 10,
  pro: 15,
} as const
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000
const OUTGOING_PROJECTION_FENCE_STATUSES:
readonly PlanChangeRequestStatus[] = [
  'requested',
  'authorization_pending',
  'old_cancellation_pending',
  'reconciling',
  'scheduled',
  'applying',
  'compensating',
  'applied',
  'review',
]

const INITIAL_INTENT_FULFILLABLE_STATUSES:
readonly CheckoutIntentStatus[] = [
  'remote_created',
  'checkout_opened',
  'authorization_pending',
  'payment_captured',
  'abandoned',
  'failed',
  'cancelled',
  'fulfilled',
]

export const SUBSCRIPTION_CYCLE_FULFILLMENT_ERROR_CODES = [
  'invalid_input',
  'reference_conflict',
  'provider_state_invalid',
  'intent_not_found',
  'intent_conflict',
  'catalog_conflict',
  'coupon_conflict',
  'price_conflict',
  'projection_arbiter_required',
  'persistence_conflict',
] as const
export type SubscriptionCycleFulfillmentErrorCode =
  (typeof SUBSCRIPTION_CYCLE_FULFILLMENT_ERROR_CODES)[number]

export class SubscriptionCycleFulfillmentError extends Error {
  readonly code: SubscriptionCycleFulfillmentErrorCode

  constructor(
    code: SubscriptionCycleFulfillmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SubscriptionCycleFulfillmentError'
    this.code = code
  }
}

export interface FulfillSubscriptionCycleInput {
  providerMode: ProviderMode
  references: SubscriptionChargedWebhookReferences
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
}

export interface OriginalSubscriptionCheckoutIntent {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'subscription' | 'single_interview' | 'premium_resume'
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId?: string
  receipt?: string
  createdAt: Date
  quote: {
    currency: string
    listPricePaise: number
    discountPaise: number
    payablePaise: number
    renewalPricePaise?: number
    discountedBillingCycles?: number
    couponCampaignId?: mongoose.Types.ObjectId
    couponCampaignRevision?: number
  }
}

export interface ResolvedSubscriptionCatalogTerms {
  version: string
  contentHash: string
  status: CatalogStatus
  effectiveAt?: Date
  publishedAt?: Date
  integrityVerified: boolean
  plan: {
    key: 'free' | 'plus' | 'pro'
    listPricePaise: number
    billingPeriod: 'none' | 'monthly'
    interviewLimit: number
    interviewPeriodOwner:
      | 'calendar_month'
      | 'razorpay_billing_cycle'
    maxInterviewDurationMinutes: number
    basicSavedResumeLimit: number
    premiumResumeLimit: number
    razorpayPlanId?: string
  }
}

export interface ResolvedSubscriptionCouponTerms {
  campaignId: mongoose.Types.ObjectId
  revision: number
  status: CouponRevisionStatus
  contentHash: string
  integrityVerified: boolean
  discountPaise: number
  applicablePlanKeys: Array<'plus' | 'pro'>
  discountedBillingCycles: number
  razorpayOfferId?: string
  startsAt?: Date
  endsAt?: Date
  bannerText?: string
  termsText: string
}

export interface ResolvedSubscriptionCommercialTerms {
  catalog: ResolvedSubscriptionCatalogTerms
  coupon?: ResolvedSubscriptionCouponTerms
}

export type SubscriptionCommercialInvariantFailure =
  | 'intent'
  | 'coupon_tuple'
  | 'catalog'
  | 'coupon_contamination'
  | 'coupon'

export interface ValidatedSubscriptionCommercialTerms {
  plan: ResolvedSubscriptionCatalogTerms['plan'] & { razorpayPlanId: string }
  coupon?: ResolvedSubscriptionCouponTerms &
    { razorpayOfferId: string }
}

export interface SubscriptionCycleCommercialResolver {
  resolve(
    intent: OriginalSubscriptionCheckoutIntent,
  ): Promise<ResolvedSubscriptionCommercialTerms | null>
}

export interface SubscriptionCycleDraft {
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  purpose: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt: Date
  userId: mongoose.Types.ObjectId
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpayOfferId?: string
  razorpaySubscriptionId: string
  razorpayInvoiceId: string
  razorpayPaymentId: string
  razorpayOrderId: string
  providerSubscriptionStatus: SubscriptionStatus
  periodKey: string
  periodStart: Date
  periodEnd: Date
  listPricePaise: number
  discountPaise: number
  capturedPaise: number
  currency: 'INR'
  couponCampaignId?: mongoose.Types.ObjectId
  couponCampaignRevision?: number
  discountedBillingCycles?: number
  interviewLimit: number
  premiumResumeLimit: number
  paymentSnapshot: RazorpayPaymentDto
}

export interface PersistSubscriptionCycleInput {
  draft: SubscriptionCycleDraft
  completedAt: Date
}

export interface SubscriptionEntitlementActivatedAnalyticsEvidence {
  readonly sourceEvidenceId: string
  readonly correlationId: string
  readonly subjectId: string
  readonly providerMode: ProviderMode
  readonly occurredAt: Date
  readonly activationKind: 'initial_subscription' | 'renewal'
  readonly productKey: 'plus' | 'pro'
  readonly catalogVersion: string
  readonly listPricePaise: number
  readonly discountPaise: number
  readonly payablePaise: number
  readonly couponCampaignId: string | null
  readonly accessEndsAt: Date
  readonly interviewsRemaining: number
  readonly premiumResumesRemaining: number
}

export interface SubscriptionEntitlementActivatedAnalyticsProducer {
  appendSubscriptionEntitlementActivatedInSession(
    evidence: () =>
      | SubscriptionEntitlementActivatedAnalyticsEvidence
      | Promise<SubscriptionEntitlementActivatedAnalyticsEvidence>,
    session: ClientSession,
  ): Promise<void>
}

export interface SubscriptionRenewedCommercialAnalyticsProducer {
  appendSubscriptionRenewedInSession(
    evidence: () =>
      | SubscriptionEntitlementActivatedAnalyticsEvidence
      | Promise<SubscriptionEntitlementActivatedAnalyticsEvidence>,
    session: ClientSession,
  ): Promise<void>
}

export type SubscriptionGraceCapturedRenewalSettlementResult =
  | {
      readonly outcome: 'not_applicable'
    }
  | {
      readonly outcome: 'counted'
      readonly caseId: string
      readonly grantId: string
      readonly sourcePaidPeriodKey: string
      readonly targetCycleId: string
      readonly targetPaidPeriodKey: string
      readonly reused: boolean
    }

export interface SubscriptionGraceCapturedRenewalSettlementPort {
  settleCapturedRenewal(
    input: {
      readonly providerMode: ProviderMode
      readonly providerSubscriptionStatus: SubscriptionStatus
      readonly userId: string
      readonly subscriptionId: string
      readonly razorpaySubscriptionId: string
      readonly sourcePaidPeriod: {
        readonly key: string
        readonly start: Date
        readonly end: Date
      }
      readonly targetCycle: {
        readonly id: string
        readonly paidPeriodKey: string
        readonly periodStart: Date
        readonly periodEnd: Date
        readonly capturedAt: Date
      }
    },
    session: ClientSession,
  ): Promise<SubscriptionGraceCapturedRenewalSettlementResult>
}
export interface SubscriptionCycleFulfillmentResult {
  checkoutIntentId: string
  localSubscriptionId: string
  subscriptionCycleId: string
  fulfillmentId: string
  periodKey: string
  reused: boolean
  projectionApplied: boolean
  projectionDisposition: RecordedProjectionDisposition
  requiresFinancialReview: boolean
  projectionReviewReason?: string
}

export interface SubscriptionCycleFulfillmentStore {
  loadOriginalIntent(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }): Promise<OriginalSubscriptionCheckoutIntent | null>
  persistCycle(
    input: PersistSubscriptionCycleInput,
    producer?: SubscriptionEntitlementActivatedAnalyticsProducer,
    renewalProducer?: SubscriptionRenewedCommercialAnalyticsProducer,
    graceSettlementPort?:
      SubscriptionGraceCapturedRenewalSettlementPort,
  ): Promise<SubscriptionCycleFulfillmentResult>
}

export interface SubscriptionCycleFulfillmentDependencies {
  store?: SubscriptionCycleFulfillmentStore
  commercialResolver?: SubscriptionCycleCommercialResolver
  now?: () => Date
  commercialAnalyticsProducer?:
    SubscriptionEntitlementActivatedAnalyticsProducer
  subscriptionRenewedAnalyticsProducer?:
    SubscriptionRenewedCommercialAnalyticsProducer
  subscriptionGraceSettlementPort?:
    SubscriptionGraceCapturedRenewalSettlementPort
}

function failure(
  code: SubscriptionCycleFulfillmentErrorCode,
  message: string,
  cause?: unknown,
): SubscriptionCycleFulfillmentError {
  return new SubscriptionCycleFulfillmentError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function sameObjectId(
  left: mongoose.Types.ObjectId,
  right: mongoose.Types.ObjectId,
): boolean {
  return left.equals(right)
}

function validDate(value: Date | undefined): value is Date {
  return Boolean(
    value instanceof Date &&
    !Number.isNaN(value.getTime()),
  )
}

function sameOptionalObjectId(
  left: mongoose.Types.ObjectId | undefined,
  right: mongoose.Types.ObjectId | undefined,
): boolean {
  if (!left || !right) return left === right
  return sameObjectId(left, right)
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

function normalizedServerEntities(
  input: FulfillSubscriptionCycleInput,
): {
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
} {
  try {
    return {
      payment: RazorpayPaymentDtoSchema.parse(input.payment),
      invoice: RazorpayInvoiceDtoSchema.parse(input.invoice),
      subscription:
        RazorpaySubscriptionDtoSchema.parse(input.subscription),
    }
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched Razorpay entities are not normalized',
      error,
    )
  }
}

function requireExactProviderReferences(input: {
  providerMode: ProviderMode
  references: SubscriptionChargedWebhookReferences
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
}): {
  razorpayOrderId: string
} {
  const {
    providerMode,
    references,
    payment,
    invoice,
    subscription,
  } = input
  if (
    references.kind !== 'subscription' ||
    references.eventType !== 'subscription.charged' ||
    references.providerMode !== providerMode ||
    payment.providerMode !== providerMode ||
    invoice.providerMode !== providerMode ||
    subscription.providerMode !== providerMode
  ) {
    throw failure(
      'reference_conflict',
      'Provider mode or webhook event family does not agree',
    )
  }

  if (
    !references.razorpayInvoiceId ||
    !references.razorpayOrderId ||
    payment.id !== references.razorpayPaymentId ||
    payment.invoiceId !== references.razorpayInvoiceId ||
    payment.orderId !== references.razorpayOrderId ||
    payment.subscriptionId !== references.razorpaySubscriptionId ||
    invoice.id !== references.razorpayInvoiceId ||
    invoice.paymentId !== references.razorpayPaymentId ||
    invoice.orderId !== references.razorpayOrderId ||
    invoice.subscriptionId !== references.razorpaySubscriptionId ||
    subscription.id !== references.razorpaySubscriptionId
  ) {
    throw failure(
      'reference_conflict',
      'Webhook, payment, invoice, and subscription references conflict',
    )
  }
  return { razorpayOrderId: references.razorpayOrderId }
}

function requireCapturedPaidInvoice(input: {
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
}): void {
  const { payment, invoice } = input
  if (
    payment.status !== 'captured' ||
    payment.captured !== true ||
    payment.amountRefundedPaise !== 0 ||
    payment.currency !== 'INR' ||
    !isInrPaise(payment.amountPaise) ||
    payment.amountPaise <= 0
  ) {
    throw failure(
      'provider_state_invalid',
      'Razorpay payment is not a captured, unrefunded INR charge',
    )
  }
  if (
    invoice.status !== 'paid' ||
    invoice.partialPayment ||
    invoice.currency !== 'INR' ||
    !isInrPaise(invoice.amountPaise) ||
    invoice.amountPaise <= 0 ||
    invoice.amountPaidPaise !== invoice.amountPaise ||
    invoice.amountDuePaise !== 0 ||
    invoice.amountPaise !== payment.amountPaise
  ) {
    throw failure(
      'provider_state_invalid',
      'Razorpay invoice is not fully and non-partially paid in INR',
    )
  }
}

function immutableInvoicePeriod(
  invoice: RazorpayInvoiceDto,
  razorpaySubscriptionId: string,
): {
  periodKey: string
  periodStart: Date
  periodEnd: Date
} {
  const start = invoice.billingStartEpochSeconds
  const end = invoice.billingEndEpochSeconds
  if (
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start
  ) {
    throw failure(
      'provider_state_invalid',
      'Paid invoice lacks immutable billing boundaries',
    )
  }
  const periodStart = new Date(start * 1_000)
  const periodEnd = new Date(end * 1_000)
  if (!validDate(periodStart) || !validDate(periodEnd)) {
    throw failure(
      'provider_state_invalid',
      'Paid invoice billing boundaries are invalid',
    )
  }
  const paidPeriod = paidBillingPeriod({
    razorpaySubscriptionId,
    currentStart: periodStart,
    currentEnd: periodEnd,
  })
  return {
    periodKey: paidPeriod.key,
    periodStart: paidPeriod.start,
    periodEnd: paidPeriod.end,
  }
}

function requirePaidPeriodStarted(
  periodStart: Date,
  completedAt: Date,
): void {
  if (
    periodStart.getTime() >
    completedAt.getTime() + PROVIDER_CLOCK_SKEW_MS
  ) {
    throw failure(
      'provider_state_invalid',
      'Paid invoice period has not started',
    )
  }
}

export function assertSubscriptionCommercialIntent<
  TIntent extends OriginalSubscriptionCheckoutIntent,
>(
  intent: TIntent,
  requirements: {
    expected?: {
      providerMode: ProviderMode
      razorpaySubscriptionId: string
    }
    strictLocalShape?: {
      receipt: unknown
    }
  },
  reject: (
    conflict: 'intent' | 'coupon_tuple',
  ) => never,
): asserts intent is TIntent & {
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  quote: TIntent['quote'] & {
    renewalPricePaise: number
  }
} {
  const quote = intent.quote
  const expected = requirements.expected
  const local = requirements.strictLocalShape
  if (
    intent.kind !== 'subscription' ||
    (intent.planKey !== 'plus' && intent.planKey !== 'pro') ||
    !INITIAL_INTENT_FULFILLABLE_STATUSES.includes(intent.status) ||
    !validDate(intent.createdAt) ||
    (
      expected
        ? (
            intent.providerMode !== expected.providerMode ||
            intent.razorpaySubscriptionId !==
              expected.razorpaySubscriptionId
          )
        : !intent.razorpaySubscriptionId
    ) ||
    (
      local !== undefined &&
      (
        typeof intent.catalogVersion !== 'string' ||
        intent.catalogVersion.trim().length === 0 ||
        typeof local.receipt !== 'string' ||
        local.receipt.length < 8 ||
        local.receipt.length > 40
      )
    ) ||
    quote.currency !== 'INR' ||
    !isInrPaise(quote.listPricePaise) ||
    quote.listPricePaise <= 0 ||
    !isInrPaise(quote.discountPaise) ||
    !isInrPaise(quote.payablePaise) ||
    !isInrPaise(quote.renewalPricePaise) ||
    quote.renewalPricePaise <= 0 ||
    quote.discountPaise > quote.listPricePaise ||
    quote.payablePaise !==
      quote.listPricePaise - quote.discountPaise
  ) {
    reject('intent')
  }

  const hasCampaign = quote.couponCampaignId !== undefined
  const hasRevision = quote.couponCampaignRevision !== undefined
  const hasCycles = quote.discountedBillingCycles !== undefined
  if (
    hasCampaign !== hasRevision ||
    hasCampaign !== hasCycles ||
    (quote.discountPaise > 0) !== hasCampaign ||
    (
      local !== undefined &&
      hasCampaign &&
      !(quote.couponCampaignId instanceof mongoose.Types.ObjectId)
    ) ||
    (
      local !== undefined &&
      hasRevision &&
      (
        !Number.isSafeInteger(quote.couponCampaignRevision) ||
        (quote.couponCampaignRevision ?? 0) <= 0
      )
    ) ||
    (
      hasCycles &&
      (
        !Number.isSafeInteger(quote.discountedBillingCycles) ||
        (quote.discountedBillingCycles ?? 0) <= 0
      )
    )
  ) {
    reject('coupon_tuple')
  }
}

export function assertSubscriptionLifecycleIntent<
  TIntent extends OriginalSubscriptionCheckoutIntent,
>(
  intent: TIntent,
  reject: (conflict: 'intent') => never,
): asserts intent is TIntent & {
  purpose: CheckoutIntentPurpose
  leaseLane: ConsumerSubscriptionLeaseLane
  authorizationExpiresAt: Date
  receipt: string
} {
  const exactEpochDate = (value: Date | undefined): value is Date => (
    validDate(value) && value.getMilliseconds() === 0
  )
  if (
    (
      intent.purpose !== 'acquisition' &&
      intent.purpose !== 'replacement' &&
      intent.purpose !== 'resubscribe'
    ) ||
    (intent.leaseLane !== 'a' && intent.leaseLane !== 'b') ||
    !exactEpochDate(intent.authorizationExpiresAt) ||
    intent.authorizationExpiresAt <= intent.createdAt ||
    typeof intent.receipt !== 'string' ||
    intent.receipt.length < 8 ||
    intent.receipt.length > 40
  ) {
    reject('intent')
  }
  if (intent.purpose === 'acquisition') {
    if (
      intent.leaseLane !== 'a' ||
      intent.planChangeRequestId !== undefined ||
      intent.replacesSubscriptionId !== undefined ||
      intent.requestedStartAt !== undefined
    ) {
      reject('intent')
    }
    return
  }
  if (
    !(intent.planChangeRequestId instanceof mongoose.Types.ObjectId) ||
    !(intent.replacesSubscriptionId instanceof mongoose.Types.ObjectId) ||
    !exactEpochDate(intent.requestedStartAt) ||
    intent.authorizationExpiresAt >= intent.requestedStartAt
  ) {
    reject('intent')
  }
}

export function requireSubscriptionCommercialTerms(input: {
  intent: OriginalSubscriptionCheckoutIntent & {
    planKey: 'plus' | 'pro'
  }
  terms: ResolvedSubscriptionCommercialTerms
  subscription: RazorpaySubscriptionDto
  strictContentHashes?: boolean
  reject: (
    conflict: 'catalog' | 'coupon_contamination' | 'coupon',
  ) => never
}): ValidatedSubscriptionCommercialTerms {
  const {
    intent,
    terms,
    subscription,
    strictContentHashes = false,
    reject,
  } = input
  const catalog = terms.catalog
  const plan = catalog.plan
  if (
    catalog.version !== intent.catalogVersion ||
    catalog.status === 'draft' ||
    catalog.status === 'scheduled' ||
    !catalog.integrityVerified ||
    !catalog.contentHash ||
    (
      strictContentHashes &&
      catalog.contentHash.length !== 64
    ) ||
    (
      catalog.effectiveAt !== undefined &&
      (
        !validDate(catalog.effectiveAt) ||
        catalog.effectiveAt > intent.createdAt
      )
    ) ||
    (
      catalog.publishedAt !== undefined &&
      (
        !validDate(catalog.publishedAt) ||
        catalog.publishedAt > intent.createdAt
      )
    ) ||
    plan.key !== intent.planKey ||
    plan.billingPeriod !== 'monthly' ||
    plan.interviewPeriodOwner !== 'razorpay_billing_cycle' ||
    plan.listPricePaise !== intent.quote.listPricePaise ||
    intent.quote.renewalPricePaise !== plan.listPricePaise ||
    plan.interviewLimit !== EXPECTED_INTERVIEW_LIMIT[intent.planKey] ||
    plan.maxInterviewDurationMinutes !== 30 ||
    plan.basicSavedResumeLimit !== 1 ||
    !Number.isSafeInteger(plan.premiumResumeLimit) ||
    plan.premiumResumeLimit < 0 ||
    !plan.razorpayPlanId ||
    plan.razorpayPlanId !== subscription.planId
  ) {
    reject('catalog')
  }

  const quote = intent.quote
  if (quote.discountPaise === 0) {
    if (terms.coupon !== undefined || subscription.offerId !== undefined) {
      reject('coupon_contamination')
    }
    return {
      plan: {
        ...plan,
        razorpayPlanId: plan.razorpayPlanId as string,
      },
    }
  }

  const coupon = terms.coupon
  if (
    !coupon ||
    !quote.couponCampaignId ||
    quote.couponCampaignRevision === undefined ||
    quote.discountedBillingCycles === undefined ||
    !sameObjectId(coupon.campaignId, quote.couponCampaignId) ||
    coupon.revision !== quote.couponCampaignRevision ||
    coupon.status === 'draft' ||
    coupon.status === 'scheduled' ||
    !coupon.integrityVerified ||
    (
      strictContentHashes &&
      coupon.contentHash.length !== 64
    ) ||
    coupon.discountPaise !== quote.discountPaise ||
    coupon.discountedBillingCycles !==
      quote.discountedBillingCycles ||
    !coupon.applicablePlanKeys.includes(intent.planKey) ||
    !coupon.razorpayOfferId ||
    subscription.offerId !== coupon.razorpayOfferId ||
    (
      coupon.startsAt !== undefined &&
      (
        !validDate(coupon.startsAt) ||
        coupon.startsAt > intent.createdAt
      )
    ) ||
    (
      coupon.endsAt !== undefined &&
      (
        !validDate(coupon.endsAt) ||
        coupon.endsAt <= intent.createdAt
      )
    )
  ) {
    reject('coupon')
  }
  const exactCoupon = coupon as ResolvedSubscriptionCouponTerms
  return {
    plan: {
      ...plan,
      razorpayPlanId: plan.razorpayPlanId as string,
    },
    coupon: {
      ...exactCoupon,
      razorpayOfferId: exactCoupon.razorpayOfferId as string,
    },
  }
}

function rejectCycleCommercialInvariant(
  conflict: SubscriptionCommercialInvariantFailure,
): never {
  if (conflict === 'catalog') {
    throw failure(
      'catalog_conflict',
      'Immutable catalog terms do not match the checkout or provider Plan',
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
        : 'Immutable coupon revision does not match the quoted Offer binding',
    )
  }
  throw failure(
    'intent_conflict',
    conflict === 'intent'
      ? 'Original subscription checkout intent is inconsistent'
      : 'Original coupon quote tuple is inconsistent',
  )
}

function requireOriginalIntent(
  intent: OriginalSubscriptionCheckoutIntent,
  expected: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  },
): asserts intent is OriginalSubscriptionCheckoutIntent & {
  planKey: 'plus' | 'pro'
  razorpaySubscriptionId: string
  quote: OriginalSubscriptionCheckoutIntent['quote'] & {
    renewalPricePaise: number
  }
  purpose: CheckoutIntentPurpose
  leaseLane: ConsumerSubscriptionLeaseLane
  authorizationExpiresAt: Date
  receipt: string
} {
  assertSubscriptionCommercialIntent(
    intent,
    { expected },
    rejectCycleCommercialInvariant,
  )
  assertSubscriptionLifecycleIntent(
    intent,
    rejectCycleCommercialInvariant,
  )
}

function requireRemoteLifecycleBinding(
  intent: OriginalSubscriptionCheckoutIntent & {
    purpose: CheckoutIntentPurpose
    leaseLane: ConsumerSubscriptionLeaseLane
    authorizationExpiresAt: Date
    receipt: string
  },
  subscription: RazorpaySubscriptionDto,
): void {
  const expectedStart = intent.requestedStartAt
    ? Math.floor(intent.requestedStartAt.getTime() / 1_000)
    : undefined
  const expectedExpiry = Math.floor(
    intent.authorizationExpiresAt.getTime() / 1_000,
  )
  if (
    subscription.notes.checkout_receipt !== intent.receipt ||
    subscription.notes.checkout_intent_id !== intent.id.toString() ||
    subscription.notes.catalog_version !== intent.catalogVersion ||
    subscription.notes.checkout_purpose !== intent.purpose ||
    subscription.notes.subscription_lease_lane !== intent.leaseLane ||
    subscription.notes.plan_change_request_id !==
      intent.planChangeRequestId?.toString() ||
    subscription.startAtEpochSeconds !== expectedStart ||
    subscription.authorizationExpiresAtEpochSeconds !== expectedExpiry
  ) {
    throw failure(
      'reference_conflict',
      'Razorpay subscription conflicts with immutable checkout lineage',
    )
  }
}

function requireCommercialTerms(input: {
  intent: OriginalSubscriptionCheckoutIntent & {
    planKey: 'plus' | 'pro'
  }
  terms: ResolvedSubscriptionCommercialTerms
  subscription: RazorpaySubscriptionDto
}): ValidatedSubscriptionCommercialTerms {
  return requireSubscriptionCommercialTerms({
    ...input,
    reject: rejectCycleCommercialInvariant,
  })
}

function deriveCyclePrice(input: {
  listPricePaise: number
  quotedDiscountPaise: number
  capturedPaise: number
  coupon?: ResolvedSubscriptionCouponTerms
}): number {
  if (input.capturedPaise === input.listPricePaise) return 0
  if (
    input.coupon &&
    input.capturedPaise ===
      input.listPricePaise - input.quotedDiscountPaise
  ) {
    return input.quotedDiscountPaise
  }
  throw failure(
    'price_conflict',
    'Captured renewal is neither list price nor the exact immutable discount',
  )
}

function providerSubscriptionStatus(
  subscription: RazorpaySubscriptionDto,
): SubscriptionStatus {
  if (
    subscription.status === 'created' ||
    subscription.status === 'authenticated'
  ) {
    throw failure(
      'provider_state_invalid',
      'Captured cycle has a pre-activation subscription state',
    )
  }
  return subscription.status
}

async function fulfillValidatedSubscriptionCycle(input: {
  providerMode: ProviderMode
  expectedSubscriptionId: string
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
  completedAt: Date
  dependencies: SubscriptionCycleFulfillmentDependencies
  validateReferences: () => string
  persistenceMessage: string
}): Promise<SubscriptionCycleFulfillmentResult> {
  input.validateReferences()
  requireCapturedPaidInvoice(input)
  const paidPeriod = immutableInvoicePeriod(
    input.invoice,
    input.subscription.id,
  )
  requirePaidPeriodStarted(paidPeriod.periodStart, input.completedAt)

  const store =
    input.dependencies.store ?? mongoSubscriptionCycleFulfillmentStore
  const resolver =
    input.dependencies.commercialResolver ??
    mongoSubscriptionCycleCommercialResolver
  const loadedIntent = await store.loadOriginalIntent({
    providerMode: input.providerMode,
    razorpaySubscriptionId: input.subscription.id,
  })
  if (!loadedIntent) {
    throw failure(
      'intent_not_found',
      'Original subscription checkout intent was not found',
    )
  }
  let terms: ResolvedSubscriptionCommercialTerms | null
  try {
    terms = await resolver.resolve(loadedIntent)
  } catch (error) {
    if (error instanceof SubscriptionCycleFulfillmentError) throw error
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

  const razorpayOrderId = input.validateReferences()
  requireCapturedPaidInvoice(input)
  const period = immutableInvoicePeriod(
    input.invoice,
    input.subscription.id,
  )
  requirePaidPeriodStarted(period.periodStart, input.completedAt)
  requireOriginalIntent(loadedIntent, {
    providerMode: input.providerMode,
    razorpaySubscriptionId: input.expectedSubscriptionId,
  })
  const intent = loadedIntent
  requireRemoteLifecycleBinding(intent, input.subscription)
  const commercial = requireCommercialTerms({
    intent,
    terms,
    subscription: input.subscription,
  })
  const { plan, coupon } = commercial
  const discountPaise = deriveCyclePrice({
    listPricePaise: plan.listPricePaise,
    quotedDiscountPaise: intent.quote.discountPaise,
    capturedPaise: input.payment.amountPaise,
    coupon,
  })
  const draft: SubscriptionCycleDraft = {
    providerMode: input.providerMode,
    checkoutIntentId: intent.id,
    purpose: intent.purpose,
    planChangeRequestId: intent.planChangeRequestId,
    replacesSubscriptionId: intent.replacesSubscriptionId,
    leaseLane: intent.leaseLane,
    requestedStartAt: intent.requestedStartAt,
    authorizationExpiresAt: intent.authorizationExpiresAt,
    userId: intent.userId,
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    razorpayPlanId: plan.razorpayPlanId,
    razorpayOfferId: coupon?.razorpayOfferId,
    razorpaySubscriptionId: input.subscription.id,
    razorpayInvoiceId: input.invoice.id,
    razorpayPaymentId: input.payment.id,
    razorpayOrderId,
    providerSubscriptionStatus:
      providerSubscriptionStatus(input.subscription),
    ...period,
    listPricePaise: plan.listPricePaise,
    discountPaise,
    capturedPaise: input.payment.amountPaise,
    currency: 'INR',
    couponCampaignId: coupon?.campaignId,
    couponCampaignRevision: coupon?.revision,
    discountedBillingCycles:
      coupon?.discountedBillingCycles,
    interviewLimit: plan.interviewLimit,
    premiumResumeLimit: plan.premiumResumeLimit,
    paymentSnapshot: input.payment,
  }
  try {
    const persistenceInput = {
      draft,
      completedAt: input.completedAt,
    }
    return (
      input.dependencies.commercialAnalyticsProducer ||
      input.dependencies.subscriptionRenewedAnalyticsProducer ||
      input.dependencies.subscriptionGraceSettlementPort
    )
      ? await store.persistCycle(
          persistenceInput,
          input.dependencies.commercialAnalyticsProducer,
          input.dependencies.subscriptionRenewedAnalyticsProducer,
          input.dependencies.subscriptionGraceSettlementPort,
        )
      : await store.persistCycle(persistenceInput)
  } catch (error) {
    if (error instanceof SubscriptionCycleFulfillmentError) throw error
    throw failure(
      'persistence_conflict',
      input.persistenceMessage,
      error,
    )
  }
}

interface LeanOriginalIntent {
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
  receipt?: string
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

function exactPlanChangeSource(
  intent: LeanOriginalIntent,
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

function toOriginalIntent(
  intent: LeanOriginalIntent,
  replacesSubscriptionId?: mongoose.Types.ObjectId,
): OriginalSubscriptionCheckoutIntent {
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

async function loadMongoOriginalIntent(input: {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  session?: ClientSession
}): Promise<OriginalSubscriptionCheckoutIntent | null> {
  const query = CheckoutIntent.findOne({
    providerMode: input.providerMode,
    razorpaySubscriptionId: input.razorpaySubscriptionId,
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
  const intent = await query.lean<LeanOriginalIntent>()
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
  return toOriginalIntent(
    intent,
    exactPlanChangeSource(intent, request),
  )
}

interface LeanCatalog {
  version: string
  status: CatalogStatus
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
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
  publishedAt?: Date
}

interface LeanCouponRevision {
  campaignId: mongoose.Types.ObjectId
  revision: number
  status: CouponRevisionStatus
  terms: {
    discountPaise: number
    applicablePlanKeys: Array<'plus' | 'pro'>
    discountedBillingCycles: number
    razorpayOfferIdByMode: Partial<Record<ProviderMode, string>>
    startsAt?: Date
    endsAt?: Date
    bannerText?: string
    termsText: string
  }
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: {
    contentHash: string
  }
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
}

function providerSnapshotMatches(
  verification: ProviderVerificationSnapshot | undefined,
  contentHash: string,
): boolean {
  return Boolean(
    verification &&
    verification.status === 'verified' &&
    verification.normalizedTermsHash === contentHash &&
    verification.errors.length === 0,
  )
}

function couponPolicyApprovalsMatch(
  coupon: LeanCouponRevision,
  catalog: LeanCatalog,
  mode: ProviderMode,
): boolean {
  const validation = coupon.validation
  if (
    !validation ||
    validation.contentHash !== coupon.contentHash ||
    validation.errors.length > 0 ||
    validation.catalogVersion !== catalog.version ||
    validation.catalogContentHash !== catalog.contentHash ||
    validation.providerMode !== mode ||
    !Array.isArray(validation.requiredPolicyApprovals)
  ) {
    return false
  }
  return validation.requiredPolicyApprovals.every((kind) => {
    const approval = coupon.policyApprovals?.[kind]
    return Boolean(
      approval &&
      approval.kind === kind &&
      approval.couponContentHash === coupon.contentHash &&
      approval.catalogVersion === catalog.version &&
      approval.catalogContentHash === catalog.contentHash &&
      approval.providerMode === mode,
    )
  })
}

async function resolveMongoCommercialTerms(
  intent: OriginalSubscriptionCheckoutIntent,
): Promise<ResolvedSubscriptionCommercialTerms | null> {
  await connectDB()
  if (intent.planKey !== 'plus' && intent.planKey !== 'pro') return null
  const catalog = await PlanCatalogVersion.findOne({
    version: intent.catalogVersion,
  }).select([
    'version',
    'status',
    'effectiveAt',
    'content',
    'contentHash',
    'validation',
    'approval',
    'providerVerification',
    'publishedAt',
  ].join(' ')).lean<LeanCatalog>()
  if (!catalog) return null

  const rawPlan = catalog.content?.plans?.[intent.planKey]
  if (!rawPlan) return null
  const catalogIntegrity = Boolean(
    catalog.validation &&
    catalog.validation.contentHash === catalog.contentHash &&
    catalog.validation.errors.length === 0 &&
    catalog.approval?.contentHash === catalog.contentHash &&
    providerSnapshotMatches(
      catalog.providerVerification?.[intent.providerMode],
      catalog.contentHash,
    ),
  )
  const resolvedCatalog: ResolvedSubscriptionCatalogTerms = {
    version: catalog.version,
    contentHash: catalog.contentHash,
    status: catalog.status,
    effectiveAt: catalog.effectiveAt,
    publishedAt: catalog.publishedAt,
    integrityVerified: catalogIntegrity,
    plan: {
      key: rawPlan.key,
      listPricePaise: rawPlan.listPricePaise,
      billingPeriod: rawPlan.billingPeriod,
      interviewLimit: rawPlan.interview.includedPerPeriod,
      interviewPeriodOwner: rawPlan.interview.periodOwner,
      maxInterviewDurationMinutes:
        rawPlan.interview.maxDurationMinutes,
      basicSavedResumeLimit:
        rawPlan.resume.basicSavedResumeLimit,
      premiumResumeLimit:
        rawPlan.resume.premiumSavedResumeLimitPerPeriod,
      razorpayPlanId:
        rawPlan.razorpayPlanIdByMode?.[intent.providerMode],
    },
  }

  const campaignId = intent.quote.couponCampaignId
  const revision = intent.quote.couponCampaignRevision
  if (!campaignId && revision === undefined) {
    return { catalog: resolvedCatalog }
  }
  if (!campaignId || revision === undefined) return null
  const coupon = await CouponCampaignRevision.findOne({
    campaignId,
    revision,
  }).select([
    'campaignId',
    'revision',
    'status',
    'terms',
    'contentHash',
    'validation',
    'approval',
    'policyApprovals',
    'providerVerification',
  ].join(' ')).lean<LeanCouponRevision>()
  if (!coupon) return null

  const integrityVerified = Boolean(
    coupon.approval?.contentHash === coupon.contentHash &&
    couponPolicyApprovalsMatch(
      coupon,
      catalog,
      intent.providerMode,
    ) &&
    providerSnapshotMatches(
      coupon.providerVerification?.[intent.providerMode],
      coupon.contentHash,
    ),
  )
  return {
    catalog: resolvedCatalog,
    coupon: {
      campaignId: coupon.campaignId,
      revision: coupon.revision,
      status: coupon.status,
      contentHash: coupon.contentHash,
      integrityVerified,
      discountPaise: coupon.terms.discountPaise,
      applicablePlanKeys: coupon.terms.applicablePlanKeys,
      discountedBillingCycles:
        coupon.terms.discountedBillingCycles,
      razorpayOfferId:
        coupon.terms.razorpayOfferIdByMode[intent.providerMode],
      startsAt: coupon.terms.startsAt,
      endsAt: coupon.terms.endsAt,
      bannerText: coupon.terms.bannerText,
      termsText: coupon.terms.termsText,
    },
  }
}

export const mongoSubscriptionCycleCommercialResolver:
SubscriptionCycleCommercialResolver = {
  resolve: resolveMongoCommercialTerms,
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
  cancelAtPeriodEnd: boolean
  scheduledPlanChange?: {
    targetPlanKey: 'plus' | 'pro'
    effectiveAt: Date
    requestedAt: Date
    source: 'customer' | 'admin'
    planChangeRequestId?: mongoose.Types.ObjectId
  }
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
  source: 'customer' | 'admin_migration'
}

interface LeanCycle {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  subscriptionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  planKey: 'plus' | 'pro'
  catalogVersion: string
  periodKey: string
  periodStart: Date
  periodEnd: Date
  razorpayInvoiceId: string
  razorpayPaymentId: string
  listPricePaise: number
  discountPaise: number
  capturedPaise: number
  currency: 'INR'
  couponCampaignRevision?: {
    campaignId: mongoose.Types.ObjectId
    revision: number
  }
  interviewLimitSnapshot: number
  premiumResumeLimitSnapshot: number
  fulfillmentStatus: 'captured'
  projectionDisposition?: SubscriptionCycleProjectionDisposition
}

interface LeanProjectionPlanChange {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: unknown
  providerMode?: ProviderMode
  operation: PlanChangeRequestOperation
  fromPlanKey: 'free' | 'plus' | 'pro'
  toPlanKey: 'free' | 'plus' | 'pro'
  targetCatalogVersion: string
  checkoutIntentId?: mongoose.Types.ObjectId
  fromSubscriptionId?: mongoose.Types.ObjectId
  toSubscriptionId?: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId?: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId?: string
  activeFenceKey?: string
  requestedAt: Date
  requestedEffectiveAt: Date
  authorizationExpiresAt?: Date
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAt?: Date
  oldCancellationAcceptedAt?: Date
  oldCancellationEffectiveAt?: Date
  status: PlanChangeRequestStatus
  outcome?: 'applied' | 'cancelled' | 'failed' | 'superseded'
  effectiveAt?: Date
}

interface LeanUserEntitlementProjection {
  _id: mongoose.Types.ObjectId
  plan: 'free' | 'plus' | 'pro' | 'enterprise'
  planVocabularyVersion?: 1 | 2
  planExpiresAt?: Date
  monthlyInterviewsUsed: number
  monthlyInterviewLimit: number
  usageResetAt?: Date
  entitlementSource?: 'free' | 'subscription' | 'admin_grant'
  usagePeriodKey?: string
  interviewsUsed?: number
  interviewLimit?: number
  premiumResumesUsed?: number
  premiumResumeLimit?: number
  entitlementVersion?: number
  buyerState?: string
}

interface LeanFulfillment {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  userId: mongoose.Types.ObjectId
  kind: string
  periodKey?: string
  status: ChargeFulfillmentStatus
  verifiedAmountPaise: number
  verifiedCurrency: string
  steps: IChargeFulfillmentSteps
  lastError?: string
}

function commercialCycleComparable(
  cycle: LeanCycle,
): Record<string, unknown> {
  return {
    providerMode: cycle.providerMode,
    subscriptionId: cycle.subscriptionId.toString(),
    userId: cycle.userId.toString(),
    planKey: cycle.planKey,
    catalogVersion: cycle.catalogVersion,
    periodKey: cycle.periodKey,
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
    razorpayInvoiceId: cycle.razorpayInvoiceId,
    razorpayPaymentId: cycle.razorpayPaymentId,
    listPricePaise: cycle.listPricePaise,
    discountPaise: cycle.discountPaise,
    capturedPaise: cycle.capturedPaise,
    currency: cycle.currency,
    couponCampaignRevision: cycle.couponCampaignRevision
      ? {
          campaignId:
            cycle.couponCampaignRevision.campaignId.toString(),
          revision: cycle.couponCampaignRevision.revision,
        }
      : undefined,
    interviewLimitSnapshot: cycle.interviewLimitSnapshot,
    premiumResumeLimitSnapshot:
      cycle.premiumResumeLimitSnapshot,
    fulfillmentStatus: cycle.fulfillmentStatus,
  }
}

function draftCycleComparable(
  draft: SubscriptionCycleDraft,
  subscriptionId: mongoose.Types.ObjectId,
): Record<string, unknown> {
  return {
    providerMode: draft.providerMode,
    subscriptionId: subscriptionId.toString(),
    userId: draft.userId.toString(),
    planKey: draft.planKey,
    catalogVersion: draft.catalogVersion,
    periodKey: draft.periodKey,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    razorpayInvoiceId: draft.razorpayInvoiceId,
    razorpayPaymentId: draft.razorpayPaymentId,
    listPricePaise: draft.listPricePaise,
    discountPaise: draft.discountPaise,
    capturedPaise: draft.capturedPaise,
    currency: draft.currency,
    couponCampaignRevision: draft.discountPaise > 0
      ? {
          campaignId: draft.couponCampaignId?.toString(),
          revision: draft.couponCampaignRevision,
        }
      : undefined,
    interviewLimitSnapshot: draft.interviewLimit,
    premiumResumeLimitSnapshot: draft.premiumResumeLimit,
    fulfillmentStatus: 'captured',
  }
}

function exactSubscription(
  subscription: LeanSubscription,
  draft: SubscriptionCycleDraft,
): boolean {
  return (
    sameObjectId(subscription.userId, draft.userId) &&
    subscription.providerMode === draft.providerMode &&
    subscription.planKey === draft.planKey &&
    subscription.catalogVersion === draft.catalogVersion &&
    subscription.razorpayPlanId === draft.razorpayPlanId &&
    subscription.razorpaySubscriptionId ===
      draft.razorpaySubscriptionId &&
    subscription.checkoutIntentId instanceof
      mongoose.Types.ObjectId &&
    sameObjectId(
      subscription.checkoutIntentId,
      draft.checkoutIntentId,
    ) &&
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
    (
      draft.couponCampaignId
        ? Boolean(
            subscription.couponCampaignId &&
            sameObjectId(
              subscription.couponCampaignId,
              draft.couponCampaignId,
            ),
          )
        : subscription.couponCampaignId === undefined
    ) &&
    (
      draft.discountedBillingCycles !== undefined
        ? Number.isSafeInteger(
            subscription.discountedCyclesRemaining,
          ) &&
          (subscription.discountedCyclesRemaining ?? -1) >= 0 &&
          (subscription.discountedCyclesRemaining ?? Infinity) <=
            draft.discountedBillingCycles
        : subscription.discountedCyclesRemaining === undefined ||
          subscription.discountedCyclesRemaining === 0
    )
  )
}

async function bootstrapOrVerifySubscription(
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<{
  subscription: LeanSubscription
  inserted: boolean
}> {
  let subscription = await Subscription.findOne({
    providerMode: draft.providerMode,
    razorpaySubscriptionId: draft.razorpaySubscriptionId,
  }).session(session).lean<LeanSubscription>()
  if (!subscription) {
    if (draft.purpose !== 'acquisition') {
      throw failure(
        'projection_arbiter_required',
        'Captured replacement has no authorized target subscription',
      )
    }
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
      status: draft.providerSubscriptionStatus,
      cancelAtPeriodEnd: false,
      couponCampaignId: draft.couponCampaignId,
      discountedCyclesRemaining:
        draft.discountedBillingCycles,
      source: 'customer',
    }], { session })
    subscription =
      created[0].toObject() as unknown as LeanSubscription
    return { subscription, inserted: true }
  }
  if (!exactSubscription(subscription, draft)) {
    throw failure(
      'persistence_conflict',
      'Existing local subscription conflicts with the captured cycle',
    )
  }
  return { subscription, inserted: false }
}

async function persistOrVerifyPaymentAttempt(
  draft: SubscriptionCycleDraft,
  completedAt: Date,
  session: ClientSession,
): Promise<void> {
  const existing = await PaymentAttempt.findOne({
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }).session(session).lean<{
    checkoutIntentId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    razorpayOrderId?: string
    razorpaySubscriptionId?: string
    razorpayInvoiceId?: string
    amountPaise: number
    currency: string
    status: string
  }>()
  if (existing) {
    if (
      !sameObjectId(
        existing.checkoutIntentId,
        draft.checkoutIntentId,
      ) ||
      !sameObjectId(existing.userId, draft.userId) ||
      existing.razorpayOrderId !== draft.razorpayOrderId ||
      existing.razorpaySubscriptionId !==
        draft.razorpaySubscriptionId ||
      existing.razorpayInvoiceId !== draft.razorpayInvoiceId ||
      existing.amountPaise !== draft.capturedPaise ||
      existing.currency !== 'INR' ||
      ['refunded', 'disputed', 'review'].includes(existing.status)
    ) {
      throw failure(
        'persistence_conflict',
        'Existing payment attempt conflicts with the captured cycle',
      )
    }
    const updated = await PaymentAttempt.updateOne(
      {
        providerMode: draft.providerMode,
        razorpayPaymentId: draft.razorpayPaymentId,
        status: { $in: ['created', 'authorized', 'captured'] },
      },
      {
        $set: {
          status: 'captured',
          providerSnapshot: draft.paymentSnapshot,
          lastSyncedAt: completedAt,
        },
      },
      { session, runValidators: true },
    )
    if (updated.matchedCount !== 1) {
      throw failure(
        'persistence_conflict',
        'Payment attempt changed during fulfillment',
      )
    }
    return
  }
  await PaymentAttempt.create([{
    providerMode: draft.providerMode,
    checkoutIntentId: draft.checkoutIntentId,
    razorpayPaymentId: draft.razorpayPaymentId,
    razorpayOrderId: draft.razorpayOrderId,
    razorpaySubscriptionId: draft.razorpaySubscriptionId,
    razorpayInvoiceId: draft.razorpayInvoiceId,
    userId: draft.userId,
    status: 'captured',
    amountPaise: draft.paymentSnapshot.amountPaise,
    currency: 'INR',
    providerSnapshot: draft.paymentSnapshot,
    lastSyncedAt: completedAt,
  }], { session })
}

function exactFulfillment(
  fulfillment: LeanFulfillment,
  draft: SubscriptionCycleDraft,
): boolean {
  return (
    fulfillment.providerMode === draft.providerMode &&
    fulfillment.razorpayPaymentId === draft.razorpayPaymentId &&
    fulfillment.razorpayInvoiceId === draft.razorpayInvoiceId &&
    fulfillment.razorpaySubscriptionId ===
      draft.razorpaySubscriptionId &&
    fulfillment.razorpayOrderId === draft.razorpayOrderId &&
    sameObjectId(fulfillment.userId, draft.userId) &&
    fulfillment.kind === 'subscription_cycle' &&
    fulfillment.periodKey === draft.periodKey &&
    fulfillment.verifiedAmountPaise === draft.capturedPaise &&
    fulfillment.verifiedCurrency === 'INR'
  )
}

async function bootstrapOrVerifyFulfillment(
  draft: SubscriptionCycleDraft,
  completedAt: Date,
  session: ClientSession,
): Promise<LeanFulfillment> {
  let fulfillment = await ChargeFulfillment.findOne({
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }).session(session).lean<LeanFulfillment>()
  const verificationOperation =
    `${draft.providerMode}:${draft.razorpayPaymentId}:verification`
  if (!fulfillment) {
    const created = await ChargeFulfillment.create([{
      providerMode: draft.providerMode,
      razorpayPaymentId: draft.razorpayPaymentId,
      razorpayInvoiceId: draft.razorpayInvoiceId,
      razorpaySubscriptionId: draft.razorpaySubscriptionId,
      razorpayOrderId: draft.razorpayOrderId,
      userId: draft.userId,
      kind: 'subscription_cycle',
      periodKey: draft.periodKey,
      status: 'verified',
      verifiedAmountPaise: draft.capturedPaise,
      verifiedCurrency: 'INR',
      steps: {
        verification: {
          status: 'complete',
          operationKey: verificationOperation,
          completedAt,
          lastAttemptAt: completedAt,
          referenceId: draft.razorpayPaymentId,
        },
        entitlement: {
          status: 'pending',
          operationKey:
            `${draft.providerMode}:` +
            `${draft.razorpayPaymentId}:entitlement`,
        },
        invoice: {
          status: 'pending',
          operationKey:
            `${draft.providerMode}:` +
            `${draft.razorpayPaymentId}:invoice`,
        },
        notification: {
          status: 'pending',
          operationKey:
            `${draft.providerMode}:` +
            `${draft.razorpayPaymentId}:notification`,
        },
      },
      attempts: 1,
    }], { session })
    return created[0].toObject() as unknown as LeanFulfillment
  }
  if (
    !exactFulfillment(fulfillment, draft) ||
    fulfillment.status === 'review'
  ) {
    throw failure(
      'persistence_conflict',
      'Existing charge fulfillment conflicts with the captured cycle',
    )
  }
  if (fulfillment.status === 'received') {
    fulfillment = await ChargeFulfillment.findOneAndUpdate(
      {
        _id: fulfillment._id,
        status: 'received',
        'steps.verification.status': { $in: ['pending', 'running'] },
      },
      {
        $set: {
          status: 'verified',
          'steps.verification': {
            status: 'complete',
            operationKey: verificationOperation,
            completedAt,
            lastAttemptAt: completedAt,
            referenceId: draft.razorpayPaymentId,
          },
        },
        $inc: { attempts: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<LeanFulfillment>()
    if (!fulfillment) {
      throw failure(
        'persistence_conflict',
        'Charge verification raced with another worker',
      )
    }
  }
  if (
    fulfillment.steps.verification.status !== 'complete' ||
    fulfillment.steps.verification.operationKey !==
      verificationOperation ||
    fulfillment.steps.verification.referenceId !==
      draft.razorpayPaymentId ||
    !validDate(fulfillment.steps.verification.completedAt)
  ) {
    throw failure(
      'persistence_conflict',
      'Charge fulfillment lacks exact verification evidence',
    )
  }
  return fulfillment
}

async function findExactExistingCycle(
  draft: SubscriptionCycleDraft,
  localSubscriptionId: mongoose.Types.ObjectId,
  session: ClientSession,
): Promise<LeanCycle | null> {
  const matches = await SubscriptionCycle.find({
    providerMode: draft.providerMode,
    $or: [
      { razorpayPaymentId: draft.razorpayPaymentId },
      { razorpayInvoiceId: draft.razorpayInvoiceId },
      {
        subscriptionId: localSubscriptionId,
        periodKey: draft.periodKey,
      },
    ],
  }).session(session).lean<LeanCycle[]>()
  if (matches.length === 0) return null
  const expected = canonicalJson(
    draftCycleComparable(draft, localSubscriptionId),
  )
  if (
    matches.some(
      (cycle) =>
        canonicalJson(commercialCycleComparable(cycle)) !==
        expected,
    ) ||
    matches.some(
      (cycle) => !cycle._id.equals(matches[0]._id),
    )
  ) {
    throw failure(
      'persistence_conflict',
      'Payment, invoice, or period belongs to a different cycle',
    )
  }
  return matches[0]
}

async function createCycle(
  draft: SubscriptionCycleDraft,
  localSubscriptionId: mongoose.Types.ObjectId,
  projectionDisposition: SubscriptionCycleProjectionDisposition,
  session: ClientSession,
): Promise<LeanCycle> {
  const created = await SubscriptionCycle.create([{
    providerMode: draft.providerMode,
    subscriptionId: localSubscriptionId,
    userId: draft.userId,
    planKey: draft.planKey,
    catalogVersion: draft.catalogVersion,
    periodKey: draft.periodKey,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    razorpayInvoiceId: draft.razorpayInvoiceId,
    razorpayPaymentId: draft.razorpayPaymentId,
    listPricePaise: draft.listPricePaise,
    discountPaise: draft.discountPaise,
    capturedPaise: draft.capturedPaise,
    currency: 'INR',
    gstInclusive: true,
    gstRateBps: 1_800,
    gstComponentAllocation: 'unallocated',
    couponCampaignRevision: draft.discountPaise > 0
      ? {
          campaignId: draft.couponCampaignId,
          revision: draft.couponCampaignRevision,
        }
      : undefined,
    interviewLimitSnapshot: draft.interviewLimit,
    premiumResumeLimitSnapshot: draft.premiumResumeLimit,
    fulfillmentStatus: 'captured',
    projectionDisposition,
  }], { session })
  return created[0].toObject() as unknown as LeanCycle
}

async function consumeDiscountCycleOnce(
  subscription: LeanSubscription,
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<number | undefined> {
  if (draft.discountPaise === 0) return undefined
  const remaining = subscription.discountedCyclesRemaining
  const total = draft.discountedBillingCycles
  if (
    !Number.isSafeInteger(remaining) ||
    (remaining ?? 0) <= 0 ||
    !Number.isSafeInteger(total) ||
    (total ?? 0) <= 0 ||
    (remaining ?? Infinity) > (total ?? -1)
  ) {
    throw failure(
      'coupon_conflict',
      'No approved discounted billing cycle remains',
    )
  }
  const remainingCycles = remaining as number
  const discountedBillingCycleNumber =
    (total as number) - remainingCycles + 1
  const update = await Subscription.updateOne(
    {
      _id: subscription._id,
      discountedCyclesRemaining: remainingCycles,
    },
    { $inc: { discountedCyclesRemaining: -1 } },
    { session, runValidators: true },
  )
  if (update.modifiedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Discount cycle attribution raced with another worker',
    )
  }
  subscription.discountedCyclesRemaining = remainingCycles - 1
  return discountedBillingCycleNumber
}

function exactEpochSeconds(value: Date | undefined): number {
  if (!validDate(value) || value.getTime() % 1_000 !== 0) {
    return Number.NaN
  }
  return value.getTime() / 1_000
}

function optionalEpochSeconds(
  value: Date | undefined,
): number | undefined {
  return value === undefined ? undefined : exactEpochSeconds(value)
}

function exactMongoValue<T>(
  value: T | undefined,
): T | { $exists: false } {
  return value === undefined ? { $exists: false } : value
}

async function loadExactProjectionCheckout(
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<OriginalSubscriptionCheckoutIntent> {
  const intent = await loadMongoOriginalIntent({
    providerMode: draft.providerMode,
    razorpaySubscriptionId: draft.razorpaySubscriptionId,
    session,
  })
  if (
    !intent ||
    !sameObjectId(intent.id, draft.checkoutIntentId) ||
    !sameObjectId(intent.userId, draft.userId) ||
    intent.kind !== 'subscription' ||
    intent.providerMode !== draft.providerMode ||
    intent.purpose !== draft.purpose ||
    !sameOptionalObjectId(
      intent.planChangeRequestId,
      draft.planChangeRequestId,
    ) ||
    !sameOptionalObjectId(
      intent.replacesSubscriptionId,
      draft.replacesSubscriptionId,
    ) ||
    intent.leaseLane !== draft.leaseLane ||
    !sameOptionalDate(
      intent.requestedStartAt,
      draft.requestedStartAt,
    ) ||
    !sameOptionalDate(
      intent.authorizationExpiresAt,
      draft.authorizationExpiresAt,
    ) ||
    intent.planKey !== draft.planKey ||
    intent.catalogVersion !== draft.catalogVersion ||
    intent.razorpaySubscriptionId !==
      draft.razorpaySubscriptionId
  ) {
    throw failure(
      'persistence_conflict',
      'Checkout lineage changed before cycle arbitration',
    )
  }
  return intent
}

async function loadProjectionPlanChange(
  subscription: LeanSubscription,
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<LeanProjectionPlanChange | null> {
  const outgoing = await PlanChangeRequest.find({
    userId: draft.userId,
    providerMode: draft.providerMode,
    fromSubscriptionId: subscription._id,
    status: { $in: OUTGOING_PROJECTION_FENCE_STATUSES },
  })
    .sort({ requestedAt: -1, _id: -1 })
    .limit(2)
    .session(session)
    .lean<LeanProjectionPlanChange[]>()
  if (outgoing.length > 1) {
    throw failure(
      'projection_arbiter_required',
      'Multiple lifecycle boundaries fence the same subscription',
    )
  }
  if (outgoing[0]) return outgoing[0]
  if (!draft.planChangeRequestId) return null
  const target = await PlanChangeRequest.findOne({
    _id: draft.planChangeRequestId,
    userId: draft.userId,
    providerMode: draft.providerMode,
  }).session(session).lean<LeanProjectionPlanChange>()
  if (!target) {
    throw failure(
      'projection_arbiter_required',
      'Target subscription has no exact lifecycle request',
    )
  }
  return target
}

function checkoutProjectionEvidence(
  intent: OriginalSubscriptionCheckoutIntent,
): ProjectionCheckoutEvidence {
  return {
    id: intent.id.toHexString(),
    userId: intent.userId.toHexString(),
    providerMode: intent.providerMode,
    purpose: intent.purpose as ProjectionCheckoutEvidence['purpose'],
    planChangeRequestId:
      intent.planChangeRequestId?.toHexString(),
    leaseLane:
      intent.leaseLane as ProjectionCheckoutEvidence['leaseLane'],
    planKey: intent.planKey as 'plus' | 'pro',
    catalogVersion: intent.catalogVersion,
    razorpaySubscriptionId:
      intent.razorpaySubscriptionId as string,
    requestedStartAtEpochSeconds:
      optionalEpochSeconds(intent.requestedStartAt),
    authorizationExpiresAtEpochSeconds:
      exactEpochSeconds(intent.authorizationExpiresAt),
    status: intent.status,
  }
}

function subscriptionProjectionEvidence(
  subscription: LeanSubscription,
  draft: SubscriptionCycleDraft,
): ProjectionSubscriptionEvidence {
  const terminalStoredStatus = [
    'cancelled',
    'completed',
    'expired',
    'review',
  ].includes(subscription.status)
  return {
    id: subscription._id.toHexString(),
    userId: subscription.userId.toHexString(),
    providerMode: subscription.providerMode,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    razorpayPlanId: subscription.razorpayPlanId,
    razorpaySubscriptionId:
      subscription.razorpaySubscriptionId,
    checkoutIntentId:
      subscription.checkoutIntentId?.toHexString() ?? '',
    planChangeRequestId:
      subscription.planChangeRequestId?.toHexString(),
    replacesSubscriptionId:
      subscription.replacesSubscriptionId?.toHexString(),
    leaseLane:
      subscription.leaseLane as ProjectionSubscriptionEvidence['leaseLane'],
    requestedStartAtEpochSeconds:
      optionalEpochSeconds(subscription.requestedStartAt),
    authorizationExpiresAtEpochSeconds:
      exactEpochSeconds(subscription.authorizationExpiresAt),
    status: terminalStoredStatus
      ? subscription.status
      : draft.providerSubscriptionStatus,
    currentPeriodKey: subscription.currentPeriodKey,
    currentPeriodStartEpochSeconds:
      optionalEpochSeconds(subscription.currentPeriodStart),
    currentPeriodEndEpochSeconds:
      optionalEpochSeconds(subscription.currentPeriodEnd),
  }
}

function planChangeProjectionEvidence(
  request: LeanProjectionPlanChange | null,
): ProjectionPlanChangeEvidence | undefined {
  if (!request) return undefined
  const controlLineage =
    classifyPlanChangeControlLineage(request)
  if (
    !request.actorUserId ||
    !controlLineage ||
    !request.providerMode ||
    request.fromPlanKey === 'free' ||
    !request.fromSubscriptionId ||
    !request.fromRazorpaySubscriptionId
  ) {
    throw failure(
      'projection_arbiter_required',
      'Lifecycle request lacks exact source evidence',
    )
  }
  return {
    id: request._id.toHexString(),
    userId: request.userId.toHexString(),
    actorUserId: request.actorUserId.toHexString(),
    source: request.source,
    controlLineage,
    ...(request.adminControl !== undefined
      ? { adminControl: request.adminControl }
      : {}),
    providerMode: request.providerMode,
    operation: request.operation,
    fromPlanKey: request.fromPlanKey,
    toPlanKey: request.toPlanKey,
    targetCatalogVersion: request.targetCatalogVersion,
    checkoutIntentId: request.checkoutIntentId?.toHexString(),
    fromSubscriptionId:
      request.fromSubscriptionId.toHexString(),
    toSubscriptionId: request.toSubscriptionId?.toHexString(),
    fromRazorpaySubscriptionId:
      request.fromRazorpaySubscriptionId,
    toRazorpaySubscriptionId:
      request.toRazorpaySubscriptionId,
    targetRazorpayPlanId: request.targetRazorpayPlanId,
    activeFenceKey: request.activeFenceKey,
    requestedAtEpochSeconds:
      exactEpochSeconds(request.requestedAt),
    requestedEffectiveAtEpochSeconds:
      exactEpochSeconds(request.requestedEffectiveAt),
    authorizationExpiresAtEpochSeconds:
      optionalEpochSeconds(request.authorizationExpiresAt),
    replacementAuthorizationPaymentId:
      request.replacementAuthorizationPaymentId,
    replacementAuthorizedAtEpochSeconds:
      optionalEpochSeconds(request.replacementAuthorizedAt),
    oldCancellationAcceptedAtEpochSeconds:
      optionalEpochSeconds(request.oldCancellationAcceptedAt),
    oldCancellationEffectiveAtEpochSeconds:
      optionalEpochSeconds(request.oldCancellationEffectiveAt),
    status: request.status,
    outcome: request.outcome,
    effectiveAtEpochSeconds:
      optionalEpochSeconds(request.effectiveAt),
  }
}

function userProjectionEvidence(
  user: LeanUserEntitlementProjection,
): UserSubscriptionProjectionEvidence | undefined {
  if (
    (user.plan !== 'plus' && user.plan !== 'pro') ||
    user.entitlementSource !== 'subscription' ||
    !user.usagePeriodKey ||
    !validDate(user.planExpiresAt)
  ) {
    return undefined
  }
  return {
    planKey: user.plan,
    entitlementSource: 'subscription',
    usagePeriodKey: user.usagePeriodKey,
    planExpiresAtEpochSeconds:
      exactEpochSeconds(user.planExpiresAt),
  }
}

function userMatchesStoredSubscriptionPeriod(
  user: LeanUserEntitlementProjection,
  subscription: LeanSubscription,
): boolean {
  if (
    user.planVocabularyVersion !==
      CURRENT_PLAN_VOCABULARY_VERSION ||
    !Number.isSafeInteger(user.entitlementVersion) ||
    (user.entitlementVersion ?? -1) < 0
  ) {
    return false
  }
  if (
    subscription.currentPeriodKey === undefined &&
    subscription.currentPeriodStart === undefined &&
    subscription.currentPeriodEnd === undefined
  ) {
    return true
  }
  const projection = userProjectionEvidence(user)
  return Boolean(
    projection &&
    validDate(subscription.currentPeriodEnd) &&
    projection.planKey === subscription.planKey &&
    projection.usagePeriodKey === subscription.currentPeriodKey &&
    projection.planExpiresAtEpochSeconds ===
      exactEpochSeconds(subscription.currentPeriodEnd),
  )
}

function projectionAuthorityReview(
  lineage: SubscriptionProjectionDecision['lineage'],
  reason:
    | 'plan_change_evidence_invalid'
    | 'user_projection_authority_mismatch',
): SubscriptionProjectionDecision {
  return {
    decision: 'review',
    lineage,
    reason,
    effects: {
      createFinancialRecords: false,
      updateSubscriptionPeriod: false,
      updateUserProjection: false,
      transitionPlanChange: false,
    },
  }
}

function freeAcquisitionAuthority(
  user: LeanUserEntitlementProjection,
): boolean {
  return (
    user.buyerState !== 'deletion_pending' &&
    user.plan === 'free' &&
    user.planVocabularyVersion ===
      CURRENT_PLAN_VOCABULARY_VERSION &&
    user.planExpiresAt === undefined &&
    user.entitlementSource === 'free' &&
    typeof user.usagePeriodKey === 'string' &&
    user.usagePeriodKey.trim().length > 0 &&
    Number.isSafeInteger(user.entitlementVersion) &&
    (user.entitlementVersion ?? -1) >= 0
  )
}

async function userCanAcceptProjection(input: {
  decision: SubscriptionProjectionDecision
  user: LeanUserEntitlementProjection
  subscription: LeanSubscription
  planChange: LeanProjectionPlanChange | null
  draft: SubscriptionCycleDraft
  session: ClientSession
}): Promise<boolean> {
  const {
    decision,
    user,
    subscription,
    planChange,
    draft,
    session,
  } = input
  if (
    user.buyerState === 'deletion_pending' ||
    user.planVocabularyVersion !==
      CURRENT_PLAN_VOCABULARY_VERSION ||
    !Number.isSafeInteger(user.entitlementVersion) ||
    (user.entitlementVersion ?? -1) < 0
  ) {
    return false
  }
  if (decision.decision !== 'project') return true
  if (decision.reason === 'plan_change_target_activates') {
    if (
      !planChange?.fromSubscriptionId ||
      !planChange.fromRazorpaySubscriptionId ||
      planChange.fromPlanKey === 'free' ||
      (
        planChange.operation !== 'tier_change' &&
        planChange.operation !== 'resubscribe'
      )
    ) {
      return false
    }
    const source = await Subscription.findOne({
      _id: planChange.fromSubscriptionId,
      userId: draft.userId,
      providerMode: draft.providerMode,
      planKey: planChange.fromPlanKey,
      razorpaySubscriptionId:
        planChange.fromRazorpaySubscriptionId,
      status: {
        $in: [
          'active',
          'pending',
          'halted',
          'paused',
          'cancelled',
          'completed',
          'expired',
        ],
      },
      currentPeriodEnd: planChange.requestedEffectiveAt,
      cancelAtPeriodEnd: true,
    }).session(session).lean<LeanSubscription>()
    const scheduledChangeExact =
      planChange.operation === 'tier_change'
        ? Boolean(
            source?.scheduledPlanChange &&
            validDate(source.scheduledPlanChange.effectiveAt) &&
            validDate(source.scheduledPlanChange.requestedAt) &&
            source.scheduledPlanChange.targetPlanKey ===
              planChange.toPlanKey &&
            source.scheduledPlanChange.effectiveAt.getTime() ===
              planChange.requestedEffectiveAt.getTime() &&
            source.scheduledPlanChange.requestedAt.getTime() ===
              planChange.requestedAt.getTime() &&
            source.scheduledPlanChange.source ===
              planChange.source &&
            sameOptionalObjectId(
              source.scheduledPlanChange.planChangeRequestId,
              planChange._id,
            ),
          )
        : source?.scheduledPlanChange === undefined
    return Boolean(
      source &&
      scheduledChangeExact &&
      validDate(source.currentPeriodStart) &&
      validDate(source.currentPeriodEnd) &&
      source.currentPeriodStart < source.currentPeriodEnd &&
      source.currentPeriodEnd.getTime() ===
        planChange.requestedEffectiveAt.getTime() &&
      userMatchesStoredSubscriptionPeriod(user, source),
    )
  }
  if (
    subscription.currentPeriodKey === undefined &&
    subscription.currentPeriodStart === undefined &&
    subscription.currentPeriodEnd === undefined
  ) {
    return freeAcquisitionAuthority(user)
  }
  return userMatchesStoredSubscriptionPeriod(user, subscription)
}

function cycleProjectionEvidence(
  cycle: SubscriptionCycleDraft,
  subscriptionId: mongoose.Types.ObjectId,
) {
  return {
    providerMode: cycle.providerMode,
    subscriptionId: subscriptionId.toHexString(),
    razorpaySubscriptionId: cycle.razorpaySubscriptionId,
    userId: cycle.userId.toHexString(),
    planKey: cycle.planKey,
    catalogVersion: cycle.catalogVersion,
    razorpayPlanId: cycle.razorpayPlanId,
    periodKey: cycle.periodKey,
    periodStartEpochSeconds:
      exactEpochSeconds(cycle.periodStart),
    periodEndEpochSeconds:
      exactEpochSeconds(cycle.periodEnd),
    razorpayInvoiceId: cycle.razorpayInvoiceId,
    razorpayPaymentId: cycle.razorpayPaymentId,
    capturedPaise: cycle.capturedPaise,
    currency: cycle.currency,
  } as const
}

function projectionDispositionFor(
  decision: SubscriptionProjectionDecision,
): RecordedProjectionDisposition | undefined {
  switch (decision.decision) {
    case 'project':
      return 'projected'
    case 'financial_history_only':
      return 'financial_history'
    case 'financial_review':
      return 'financial_review'
    case 'review':
      return 'financial_review'
    case 'noop_verify':
      return undefined
  }
}

async function applyCurrentProjection(
  subscription: LeanSubscription,
  user: LeanUserEntitlementProjection,
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<void> {
  const subscriptionUpdate = await Subscription.updateOne(
    {
      _id: subscription._id,
      providerMode: draft.providerMode,
      razorpaySubscriptionId: draft.razorpaySubscriptionId,
      status: subscription.status,
      currentPeriodKey:
        exactMongoValue(subscription.currentPeriodKey),
      currentPeriodStart:
        exactMongoValue(subscription.currentPeriodStart),
      currentPeriodEnd:
        exactMongoValue(subscription.currentPeriodEnd),
    },
    {
      $set: {
        status: draft.providerSubscriptionStatus,
        currentPeriodKey: draft.periodKey,
        currentPeriodStart: draft.periodStart,
        currentPeriodEnd: draft.periodEnd,
      },
    },
    { session, runValidators: true },
  )
  if (subscriptionUpdate.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Subscription current period could not be advanced',
    )
  }

  const userUpdate =
    await commitUserEntitlementProjectionUpdateInSession(
    'subscription_cycle',
    {
      _id: draft.userId,
      plan: user.plan,
      planVocabularyVersion:
        exactMongoValue(user.planVocabularyVersion),
      planExpiresAt: exactMongoValue(user.planExpiresAt),
      entitlementSource:
        exactMongoValue(user.entitlementSource),
      usagePeriodKey: exactMongoValue(user.usagePeriodKey),
      entitlementVersion:
        exactMongoValue(user.entitlementVersion),
      buyerState: exactMongoValue(user.buyerState),
    },
    {
      $set: {
        plan: draft.planKey,
        planVocabularyVersion: CURRENT_PLAN_VOCABULARY_VERSION,
        planExpiresAt: draft.periodEnd,
        monthlyInterviewsUsed: 0,
        monthlyInterviewLimit: draft.interviewLimit,
        usageResetAt: draft.periodEnd,
        entitlementSource: 'subscription',
        usagePeriodKey: draft.periodKey,
        interviewsUsed: 0,
        interviewLimit: draft.interviewLimit,
        premiumResumesUsed: 0,
        premiumResumeLimit: draft.premiumResumeLimit,
      },
      $inc: { entitlementVersion: 1 },
    },
    session,
  )
  if (userUpdate.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Subscription user projection could not be applied',
    )
  }
  // freeBasicResumeId is intentionally absent from the update. A paid-cycle
  // reset must preserve the user's single Basic resume identity.
}

async function requireStableReplayProjection(input: {
  cycle: LeanCycle
  draft: SubscriptionCycleDraft
  session: ClientSession
}): Promise<LeanFulfillment> {
  const { cycle, draft, session } = input
  const attempt = await PaymentAttempt.findOne({
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }).session(session).lean<{
    checkoutIntentId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
    razorpayOrderId?: string
    razorpaySubscriptionId?: string
    razorpayInvoiceId?: string
    amountPaise: number
    currency: string
    status: string
  }>()
  const fulfillment = await ChargeFulfillment.findOne({
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }).session(session).lean<LeanFulfillment>()
  const monotonicPaymentStatuses = new Set([
    'captured',
    'review',
    'refunded',
    'disputed',
  ])
  if (
    !attempt ||
    !fulfillment ||
    !sameObjectId(
      attempt.checkoutIntentId,
      draft.checkoutIntentId,
    ) ||
    !sameObjectId(attempt.userId, draft.userId) ||
    attempt.razorpayOrderId !== draft.razorpayOrderId ||
    attempt.razorpaySubscriptionId !==
      draft.razorpaySubscriptionId ||
    attempt.razorpayInvoiceId !== draft.razorpayInvoiceId ||
    attempt.amountPaise !== draft.capturedPaise ||
    attempt.currency !== 'INR' ||
    !monotonicPaymentStatuses.has(attempt.status) ||
    !exactFulfillment(fulfillment, draft) ||
    fulfillment.steps.verification.status !== 'complete' ||
    fulfillment.steps.verification.referenceId !==
      draft.razorpayPaymentId ||
    fulfillment.steps.verification.operationKey !==
      `${draft.providerMode}:` +
        `${draft.razorpayPaymentId}:verification`
  ) {
    throw failure(
      'persistence_conflict',
      'Cycle replay lacks exact immutable financial evidence',
    )
  }
  const entitlement = fulfillment.steps.entitlement
  const exactEntitlementReference =
    entitlement.referenceId === cycle._id.toHexString() &&
    entitlement.operationKey ===
      `${draft.providerMode}:` +
        `${draft.razorpayPaymentId}:entitlement`
  const coherent = (() => {
    switch (cycle.projectionDisposition) {
      case 'projected':
        return (
          entitlement.status === 'complete' &&
          exactEntitlementReference &&
          [
            'entitlement_applied',
            'invoiced',
            'notified',
            'done',
            'review',
          ].includes(fulfillment.status)
        )
      case 'financial_history':
        return (
          entitlement.status === 'skipped' &&
          exactEntitlementReference &&
          [
            'entitlement_skipped',
            'invoiced',
            'notified',
            'done',
            'review',
          ].includes(fulfillment.status)
        )
      case 'financial_review':
        return (
          fulfillment.status === 'review' &&
          entitlement.status === 'pending' &&
          exactEntitlementReference
        )
      case undefined:
        return false
    }
  })()
  if (!coherent) {
    throw failure(
      'persistence_conflict',
      'Cycle replay has a divergent projection disposition fence',
    )
  }
  return fulfillment
}

function exactPlanChangeTransitionFilter(
  request: LeanProjectionPlanChange,
  status: PlanChangeRequestStatus,
): Record<string, unknown> {
  const controlFilter = exactPlanChangeControlFilter(request)
  if (!controlFilter) {
    throw failure(
      'projection_arbiter_required',
      'Lifecycle control lineage is not actionable',
    )
  }
  return {
    _id: request._id,
    userId: request.userId,
    ...controlFilter,
    providerMode: exactMongoValue(request.providerMode),
    operation: request.operation,
    fromPlanKey: request.fromPlanKey,
    toPlanKey: request.toPlanKey,
    targetCatalogVersion: request.targetCatalogVersion,
    checkoutIntentId:
      exactMongoValue(request.checkoutIntentId),
    fromSubscriptionId:
      exactMongoValue(request.fromSubscriptionId),
    toSubscriptionId: exactMongoValue(request.toSubscriptionId),
    fromRazorpaySubscriptionId:
      exactMongoValue(request.fromRazorpaySubscriptionId),
    toRazorpaySubscriptionId:
      exactMongoValue(request.toRazorpaySubscriptionId),
    targetRazorpayPlanId:
      exactMongoValue(request.targetRazorpayPlanId),
    requestedAt: request.requestedAt,
    requestedEffectiveAt: request.requestedEffectiveAt,
    authorizationExpiresAt:
      exactMongoValue(request.authorizationExpiresAt),
    replacementAuthorizationPaymentId:
      exactMongoValue(
        request.replacementAuthorizationPaymentId,
      ),
    replacementAuthorizedAt:
      exactMongoValue(request.replacementAuthorizedAt),
    oldCancellationAcceptedAt:
      exactMongoValue(request.oldCancellationAcceptedAt),
    oldCancellationEffectiveAt:
      exactMongoValue(request.oldCancellationEffectiveAt),
    activeFenceKey: exactMongoValue(request.activeFenceKey),
    outcome: exactMongoValue(request.outcome),
    effectiveAt: exactMongoValue(request.effectiveAt),
    status,
  }
}

async function markPlanChangeFinancialReview(input: {
  request: LeanProjectionPlanChange | null
  reason: string
  session: ClientSession
}): Promise<void> {
  const { request, reason, session } = input
  if (
    !request ||
    classifyPlanChangeControlLineage(request) !== 'customer' ||
    request.status === 'applied' ||
    request.status === 'cancelled' ||
    request.status === 'failed'
  ) {
    return
  }
  const status = transitionPlanChangeStatus({
    operation: request.operation,
    currentStatus: request.status,
    event: { type: 'review_required' },
  })
  const update = await PlanChangeRequest.updateOne(
    exactPlanChangeTransitionFilter(request, request.status),
    {
      $set: {
        status,
        lastError: reason,
      },
    },
    { session, runValidators: true },
  )
  if (update.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Plan-change review fence raced with another worker',
    )
  }
}

async function transitionAppliedTargetPlanChange(input: {
  request: LeanProjectionPlanChange | null
  subscription: LeanSubscription
  draft: SubscriptionCycleDraft
  completedAt: Date
  session: ClientSession
  applyProjection: () => Promise<void>
}): Promise<void> {
  const {
    request,
    subscription,
    draft,
    completedAt,
    session,
    applyProjection,
  } = input
  if (
    !request ||
    classifyPlanChangeControlLineage(request) !== 'customer' ||
    (request.operation !== 'tier_change' &&
      request.operation !== 'resubscribe') ||
    request.fromPlanKey === 'free' ||
    request.toPlanKey === 'free' ||
    request.status !== 'scheduled' ||
    !request.toSubscriptionId ||
    !request.toSubscriptionId.equals(subscription._id) ||
    request.toRazorpaySubscriptionId !==
      draft.razorpaySubscriptionId
  ) {
    throw failure(
      'projection_arbiter_required',
      'Projected target lacks an exact scheduled lifecycle request',
    )
  }
  const fromPlanKey = request.fromPlanKey
  const toPlanKey = request.toPlanKey
  const applying = transitionPlanChangeStatus({
    operation: request.operation,
    currentStatus: request.status,
    event: {
      type: 'target_cycle_captured',
      evidence: {
        paymentId: draft.razorpayPaymentId,
        capturedAt: completedAt,
        periodKey: draft.periodKey,
      },
    },
  })
  const started = await PlanChangeRequest.updateOne(
    {
      ...exactPlanChangeTransitionFilter(
        request,
        request.status,
      ),
      activeFenceKey:
        `${draft.providerMode}:${draft.userId.toHexString()}`,
      toRazorpaySubscriptionId: draft.razorpaySubscriptionId,
    },
    {
      $set: {
        status: applying,
        lastProviderObservedAt: completedAt,
      },
    },
    { session, runValidators: true },
  )
  if (started.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Plan change could not enter applying state',
    )
  }
  await applyProjection()
  const applied = transitionPlanChangeStatus({
    operation: request.operation,
    currentStatus: applying,
    event: {
      type: 'projection_committed',
      committedAt: completedAt,
    },
  })
  const committed = await PlanChangeRequest.updateOne(
    {
      ...exactPlanChangeTransitionFilter(request, applying),
      activeFenceKey:
        `${draft.providerMode}:${draft.userId.toHexString()}`,
    },
    {
      $set: {
        status: applied,
        outcome: 'applied',
        outcomeAt: completedAt,
        effectiveAt: request.requestedEffectiveAt,
        outcomeReason:
          'Captured target cycle and entitlement projection committed',
      },
      $unset: {
        activeFenceKey: '',
        nextRecoveryAt: '',
        lastError: '',
      },
    },
    { session, runValidators: true },
  )
  if (committed.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Plan change could not commit its applied outcome',
    )
  }
  if (request.operation === 'tier_change') {
    const oldSubscription = await Subscription.updateOne(
      {
        _id: request.fromSubscriptionId,
        userId: request.userId,
        providerMode: request.providerMode,
        planKey: fromPlanKey,
        razorpaySubscriptionId:
          request.fromRazorpaySubscriptionId,
        currentPeriodEnd: request.requestedEffectiveAt,
        cancelAtPeriodEnd: true,
        'scheduledPlanChange.targetPlanKey':
          toPlanKey,
        'scheduledPlanChange.effectiveAt':
          request.requestedEffectiveAt,
        'scheduledPlanChange.requestedAt':
          request.requestedAt,
        'scheduledPlanChange.source': request.source,
        'scheduledPlanChange.planChangeRequestId': request._id,
      },
      { $unset: { scheduledPlanChange: '' } },
      { session, runValidators: true },
    )
    if (oldSubscription.matchedCount !== 1) {
      throw failure(
        'persistence_conflict',
        'Old subscription lost its scheduled plan-change fence',
      )
    }
  }
}

async function advanceEntitlementFence(input: {
  fulfillment: LeanFulfillment
  cycle: LeanCycle
  draft: SubscriptionCycleDraft
  disposition: RecordedProjectionDisposition
  reason: string
  completedAt: Date
  session: ClientSession
}): Promise<void> {
  const {
    fulfillment,
    cycle,
    draft,
    disposition,
    reason,
    completedAt,
    session,
  } = input
  if (disposition === 'financial_review') {
    const attempt = await PaymentAttempt.updateOne(
      {
        providerMode: draft.providerMode,
        razorpayPaymentId: draft.razorpayPaymentId,
        status: 'captured',
      },
      {
        $set: {
          status: 'review',
          lastSyncedAt: completedAt,
        },
      },
      { session, runValidators: true },
    )
    const reviewed = await ChargeFulfillment.updateOne(
      {
        _id: fulfillment._id,
        status: 'verified',
        'steps.entitlement.status': 'pending',
        'steps.entitlement.operationKey':
          `${draft.providerMode}:` +
          `${draft.razorpayPaymentId}:entitlement`,
        'steps.entitlement.referenceId': { $exists: false },
      },
      {
        $set: {
          status: 'review',
          lastError: reason,
          'steps.entitlement.referenceId':
            cycle._id.toHexString(),
          'steps.entitlement.lastAttemptAt': completedAt,
        },
      },
      { session, runValidators: true },
    )
    if (
      attempt.matchedCount !== 1 ||
      reviewed.matchedCount !== 1
    ) {
      throw failure(
        'persistence_conflict',
        'Financial-review fence raced with another worker',
      )
    }
    return
  }
  if (fulfillment.status === 'verified') {
    /*
     * Reversal invariant: every future refund/dispute revocation MUST CAS this
     * same ChargeFulfillment row (including the observed status and operation
     * key) in its transaction. That makes entitlement application and reversal
     * contend on one document; neither path may grant/revoke from PaymentAttempt
     * or SubscriptionCycle alone.
     */
    const advanced = await ChargeFulfillment.findOneAndUpdate(
      {
        _id: fulfillment._id,
        status: 'verified',
        'steps.entitlement.status': { $in: ['pending', 'running'] },
        'steps.entitlement.operationKey':
          `${draft.providerMode}:` +
          `${draft.razorpayPaymentId}:entitlement`,
      },
      {
        $set: {
          status: disposition === 'projected'
            ? 'entitlement_applied'
            : 'entitlement_skipped',
          'steps.entitlement': {
            status: disposition === 'projected'
              ? 'complete'
              : 'skipped',
            operationKey:
              `${draft.providerMode}:` +
              `${draft.razorpayPaymentId}:entitlement`,
            completedAt,
            lastAttemptAt: completedAt,
            referenceId: cycle._id.toString(),
          },
        },
      },
      { new: true, runValidators: true, session },
    ).lean<LeanFulfillment>()
    if (!advanced) {
      throw failure(
        'persistence_conflict',
        'Entitlement fence raced with fulfillment or reversal',
      )
    }
    return
  }
  const expectedStepStatus =
    disposition === 'projected' ? 'complete' : 'skipped'
  const expectedFulfillmentStatuses:
  readonly ChargeFulfillmentStatus[] =
    disposition === 'projected'
      ? ['entitlement_applied', 'invoiced', 'notified', 'done']
      : ['entitlement_skipped', 'invoiced', 'notified', 'done']
  if (
    fulfillment.steps.entitlement.status !== expectedStepStatus ||
    !expectedFulfillmentStatuses.includes(fulfillment.status) ||
    fulfillment.steps.entitlement.referenceId !==
      cycle._id.toString() ||
    fulfillment.steps.entitlement.operationKey !==
      `${draft.providerMode}:` +
        `${draft.razorpayPaymentId}:entitlement`
  ) {
    throw failure(
      'persistence_conflict',
      'Advanced fulfillment references a different subscription cycle',
    )
  }
}

async function fulfillInitialIntent(
  draft: SubscriptionCycleDraft,
  session: ClientSession,
): Promise<void> {
  const current = await loadMongoOriginalIntent({
    providerMode: draft.providerMode,
    razorpaySubscriptionId: draft.razorpaySubscriptionId,
    session,
  })
  if (
    !current ||
    !sameObjectId(current.id, draft.checkoutIntentId) ||
    !sameObjectId(current.userId, draft.userId) ||
    current.purpose !== draft.purpose ||
    !sameOptionalObjectId(
      current.planChangeRequestId,
      draft.planChangeRequestId,
    ) ||
    !sameOptionalObjectId(
      current.replacesSubscriptionId,
      draft.replacesSubscriptionId,
    ) ||
    current.leaseLane !== draft.leaseLane ||
    !sameOptionalDate(
      current.requestedStartAt,
      draft.requestedStartAt,
    ) ||
    !sameOptionalDate(
      current.authorizationExpiresAt,
      draft.authorizationExpiresAt,
    ) ||
    current.planKey !== draft.planKey ||
    current.catalogVersion !== draft.catalogVersion ||
    !INITIAL_INTENT_FULFILLABLE_STATUSES.includes(current.status)
  ) {
    throw failure(
      'persistence_conflict',
      'Original checkout intent changed before cycle persistence',
    )
  }
  if (current.status === 'fulfilled') return
  const update = await CheckoutIntent.updateOne(
    {
      _id: current.id,
      providerMode: draft.providerMode,
      razorpaySubscriptionId: draft.razorpaySubscriptionId,
      status: current.status,
    },
    { $set: { status: 'fulfilled' } },
    { session, runValidators: true },
  )
  if (update.modifiedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Original checkout intent could not advance to fulfilled',
    )
  }
}

async function subscriptionActivationEvidence(input: {
  cycle: LeanCycle
  draft: SubscriptionCycleDraft
  occurredAt: Date
  priorCycleAuthority: 'projected' | 'captured'
  session: ClientSession
}): Promise<SubscriptionEntitlementActivatedAnalyticsEvidence> {
  const prior = await SubscriptionCycle.findOne({
    subscriptionId: input.cycle.subscriptionId,
    ...(input.priorCycleAuthority === 'projected'
      ? { projectionDisposition: 'projected' }
      : {}),
    periodStart: { $lt: input.draft.periodStart },
  })
    .select('_id')
    .session(input.session)
    .lean<{ _id: mongoose.Types.ObjectId }>()
  return {
    sourceEvidenceId: input.cycle._id.toHexString(),
    correlationId: input.draft.checkoutIntentId.toHexString(),
    subjectId: input.draft.userId.toHexString(),
    providerMode: input.draft.providerMode,
    occurredAt: input.occurredAt,
    activationKind: prior ? 'renewal' : 'initial_subscription',
    productKey: input.draft.planKey,
    catalogVersion: input.draft.catalogVersion,
    listPricePaise: input.draft.listPricePaise,
    discountPaise: input.draft.discountPaise,
    payablePaise: input.draft.capturedPaise,
    couponCampaignId:
      input.draft.couponCampaignId?.toHexString() ?? null,
    accessEndsAt: input.draft.periodEnd,
    interviewsRemaining: input.draft.interviewLimit,
    premiumResumesRemaining: input.draft.premiumResumeLimit,
  }
}

async function previousProjectedSubscriptionCycle(input: {
  cycle: LeanCycle
  session: ClientSession
}): Promise<LeanCycle | null> {
  const rows = await SubscriptionCycle.find({
    providerMode: input.cycle.providerMode,
    subscriptionId: input.cycle.subscriptionId,
    userId: input.cycle.userId,
    fulfillmentStatus: 'captured',
    projectionDisposition: 'projected',
    periodKey: { $ne: input.cycle.periodKey },
    periodEnd: input.cycle.periodStart,
  })
    .sort({ periodStart: -1, _id: -1 })
    .limit(2)
    .session(input.session)
    .lean<LeanCycle[]>()
  if (rows.length > 1) {
    throw failure(
      'persistence_conflict',
      'Captured renewal has ambiguous prior paid-cycle authority',
    )
  }
  return rows[0] ?? null
}

async function settleConsumedSubscriptionGraceAgainstCycle(input: {
  cycle: LeanCycle
  draft: SubscriptionCycleDraft
  completedAt: Date
  session: ClientSession
  port?: SubscriptionGraceCapturedRenewalSettlementPort
}): Promise<0 | 1> {
  if (!input.port) return 0
  const previous = await previousProjectedSubscriptionCycle({
    cycle: input.cycle,
    session: input.session,
  })
  if (!previous) return 0
  const settlement = await input.port.settleCapturedRenewal({
    providerMode: input.draft.providerMode,
    providerSubscriptionStatus:
      input.draft.providerSubscriptionStatus,
    userId: input.draft.userId.toHexString(),
    subscriptionId:
      input.cycle.subscriptionId.toHexString(),
    razorpaySubscriptionId:
      input.draft.razorpaySubscriptionId,
    sourcePaidPeriod: {
      key: previous.periodKey,
      start: new Date(previous.periodStart),
      end: new Date(previous.periodEnd),
    },
    targetCycle: {
      id: input.cycle._id.toHexString(),
      paidPeriodKey: input.cycle.periodKey,
      periodStart: new Date(input.cycle.periodStart),
      periodEnd: new Date(input.cycle.periodEnd),
      capturedAt: new Date(input.completedAt),
    },
  }, input.session)
  if (settlement.outcome === 'not_applicable') return 0
  if (
    !OBJECT_ID_PATTERN.test(settlement.caseId) ||
    !OBJECT_ID_PATTERN.test(settlement.grantId) ||
    settlement.sourcePaidPeriodKey !== previous.periodKey ||
    settlement.targetCycleId !==
      input.cycle._id.toHexString() ||
    settlement.targetPaidPeriodKey !== input.cycle.periodKey
  ) {
    throw failure(
      'persistence_conflict',
      'Captured renewal grace settlement returned inconsistent authority',
    )
  }
  if (settlement.reused) return 1

  const user = await User.findOne({
    _id: input.draft.userId,
    buyerState: { $ne: 'deletion_pending' },
    deletionPendingAt: { $exists: false },
    plan: input.draft.planKey,
    planVocabularyVersion: CURRENT_PLAN_VOCABULARY_VERSION,
    planExpiresAt: input.draft.periodEnd,
    entitlementSource: 'subscription',
    usagePeriodKey: input.draft.periodKey,
    usageResetAt: input.draft.periodEnd,
    interviewLimit: input.draft.interviewLimit,
  })
    .select('interviewsUsed entitlementVersion')
    .session(input.session)
    .lean<{
      interviewsUsed: number
      entitlementVersion: number
    }>()
  if (
    !user ||
    !Number.isSafeInteger(user.interviewsUsed) ||
    user.interviewsUsed < 0 ||
    user.interviewsUsed >= input.draft.interviewLimit ||
    !Number.isSafeInteger(user.entitlementVersion) ||
    user.entitlementVersion < 1 ||
    user.entitlementVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw failure(
      'persistence_conflict',
      'Captured renewal cannot debit its provisional interview',
    )
  }
  const updated =
    await commitUserEntitlementProjectionUpdateInSession(
      'subscription_cycle',
      {
        _id: input.draft.userId,
        buyerState: { $ne: 'deletion_pending' },
        deletionPendingAt: { $exists: false },
        plan: input.draft.planKey,
        planVocabularyVersion:
          CURRENT_PLAN_VOCABULARY_VERSION,
        planExpiresAt: input.draft.periodEnd,
        entitlementSource: 'subscription',
        usagePeriodKey: input.draft.periodKey,
        usageResetAt: input.draft.periodEnd,
        interviewLimit: input.draft.interviewLimit,
        interviewsUsed: user.interviewsUsed,
        entitlementVersion: user.entitlementVersion,
      },
      {
        $inc: {
          interviewsUsed: 1,
          entitlementVersion: 1,
        },
      },
      input.session,
    )
  if (updated.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Captured renewal grace debit raced with entitlement usage',
    )
  }
  return 1
}

async function persistMongoCycleOnce(
  input: PersistSubscriptionCycleInput,
  producer?: SubscriptionEntitlementActivatedAnalyticsProducer,
  renewalProducer?: SubscriptionRenewedCommercialAnalyticsProducer,
  graceSettlementPort?:
    SubscriptionGraceCapturedRenewalSettlementPort,
): Promise<SubscriptionCycleFulfillmentResult> {
  const session = await mongoose.startSession()
  let result: SubscriptionCycleFulfillmentResult | undefined
  try {
    await session.withTransaction(async () => {
      const { draft, completedAt } = input
      const local = await bootstrapOrVerifySubscription(
        draft,
        session,
      )
      const checkout = await loadExactProjectionCheckout(
        draft,
        session,
      )
      let cycle = await findExactExistingCycle(
        draft,
        local.subscription._id,
        session,
      )
      if (cycle && !cycle.projectionDisposition) {
        throw failure(
          'projection_arbiter_required',
          'Legacy cycle has no immutable projection disposition',
        )
      }
      if (cycle) {
        const replayedCycle = cycle
        const fulfillment = await requireStableReplayProjection({
          cycle: replayedCycle,
          draft,
          session,
        })
        const disposition =
          cycle.projectionDisposition as RecordedProjectionDisposition
        if (disposition === 'projected') {
          const persistedCompletedAt =
            fulfillment.steps.entitlement.completedAt
          if (!validDate(persistedCompletedAt)) {
            throw failure(
              'persistence_conflict',
              'Cycle replay has no stable entitlement completion clock',
            )
          }
          const graceInterviewsCounted =
            await settleConsumedSubscriptionGraceAgainstCycle({
            cycle: replayedCycle,
            draft,
            completedAt: persistedCompletedAt,
            session,
            port: graceSettlementPort,
          })
          const analyticsDraft = graceInterviewsCounted === 1
            ? {
                ...draft,
                interviewLimit: draft.interviewLimit - 1,
              }
            : draft
          await producer
            ?.appendSubscriptionEntitlementActivatedInSession(
              () => subscriptionActivationEvidence({
                cycle: replayedCycle,
                draft: analyticsDraft,
                occurredAt: persistedCompletedAt,
                priorCycleAuthority: 'projected',
                session,
              }),
              session,
            )
        }
        result = {
          checkoutIntentId: draft.checkoutIntentId.toString(),
          localSubscriptionId:
            local.subscription._id.toString(),
          subscriptionCycleId: cycle._id.toString(),
          fulfillmentId: fulfillment._id.toString(),
          periodKey: draft.periodKey,
          reused: true,
          projectionApplied: false,
          projectionDisposition: disposition,
          requiresFinancialReview:
            disposition === 'financial_review',
          ...(disposition === 'financial_review'
            ? {
                projectionReviewReason:
                  fulfillment.lastError ??
                  'durable_financial_review',
              }
            : {}),
        }
        return
      }

      let planChange: LeanProjectionPlanChange | null = null
      let forcedReview:
        | 'plan_change_evidence_invalid'
        | 'user_projection_authority_mismatch'
        | undefined
      try {
        planChange = await loadProjectionPlanChange(
          local.subscription,
          draft,
          session,
        )
      } catch (error) {
        if (
          error instanceof SubscriptionCycleFulfillmentError &&
          error.code === 'projection_arbiter_required'
        ) {
          forcedReview = 'plan_change_evidence_invalid'
        } else {
          throw error
        }
      }
      const user = await User.findById(draft.userId)
        .select([
          '_id',
          'plan',
          'planVocabularyVersion',
          'planExpiresAt',
          'monthlyInterviewsUsed',
          'monthlyInterviewLimit',
          'usageResetAt',
          'entitlementSource',
          'usagePeriodKey',
          'interviewsUsed',
          'interviewLimit',
          'premiumResumesUsed',
          'premiumResumeLimit',
          'entitlementVersion',
          'buyerState',
        ].join(' '))
        .session(session)
        .lean<LeanUserEntitlementProjection>()
      if (!user || !user._id.equals(draft.userId)) {
        forcedReview = 'user_projection_authority_mismatch'
      }
      const cycleEvidence = cycleProjectionEvidence(
        draft,
        local.subscription._id,
      )
      let decision: SubscriptionProjectionDecision
      if (forcedReview) {
        decision = projectionAuthorityReview('unknown', forcedReview)
      } else {
        try {
          decision = arbitrateSubscriptionCycleProjection({
            cycle: cycleEvidence,
            subscription: subscriptionProjectionEvidence(
              local.subscription,
              draft,
            ),
            checkout: checkoutProjectionEvidence(checkout),
            planChange: planChangeProjectionEvidence(planChange),
            userProjection: user
              ? userProjectionEvidence(user)
              : undefined,
          })
        } catch (error) {
          if (
            error instanceof SubscriptionCycleFulfillmentError &&
            error.code === 'projection_arbiter_required'
          ) {
            decision = projectionAuthorityReview(
              'unknown',
              'plan_change_evidence_invalid',
            )
          } else {
            throw error
          }
        }
      }
      if (
        decision.decision === 'project' &&
        (
          !user ||
          !await userCanAcceptProjection({
            decision,
            user,
            subscription: local.subscription,
            planChange,
            draft,
            session,
          })
        )
      ) {
        decision = projectionAuthorityReview(
          decision.lineage,
          'user_projection_authority_mismatch',
        )
      }
      if (decision.decision === 'noop_verify') {
        throw failure(
          'persistence_conflict',
          'A new cycle cannot be classified as a replay',
        )
      }
      const disposition = projectionDispositionFor(decision)
      if (!disposition) {
        throw failure(
          'projection_arbiter_required',
          'Projection decision lacks a durable disposition',
        )
      }
      await persistOrVerifyPaymentAttempt(
        draft,
        completedAt,
        session,
      )
      const fulfillment = await bootstrapOrVerifyFulfillment(
        draft,
        completedAt,
        session,
      )
      {
        const discountedBillingCycleNumber =
          await consumeDiscountCycleOnce(
            local.subscription,
            draft,
            session,
          )
        cycle = await createCycle(
          draft,
          local.subscription._id,
          disposition,
          session,
        )
        if (discountedBillingCycleNumber !== undefined) {
          if (
            !draft.couponCampaignId ||
            draft.couponCampaignRevision === undefined
          ) {
            throw failure(
              'coupon_conflict',
              'Discounted cycle lacks its coupon reservation binding',
            )
          }
          await convertCouponReservationCycleInSession({
            providerMode: draft.providerMode,
            campaignId: draft.couponCampaignId.toString(),
            campaignRevision: draft.couponCampaignRevision,
            userId: draft.userId.toString(),
            checkoutIntentId: draft.checkoutIntentId.toString(),
            paymentId: draft.razorpayPaymentId,
            subscriptionId: draft.razorpaySubscriptionId,
            discountedBillingCycleNumber,
            capturedAt: completedAt,
          }, session)
        }
      }
      const projectionApplied = decision.decision === 'project'
      if (projectionApplied) {
        if (!user) {
          throw failure(
            'persistence_conflict',
            'Projection decision has no User authority row',
          )
        }
        const applyProjection = () => applyCurrentProjection(
          local.subscription,
          user,
          draft,
          session,
        )
        if (decision.effects.transitionPlanChange) {
          await transitionAppliedTargetPlanChange({
            request: planChange,
            subscription: local.subscription,
            draft,
            completedAt,
            session,
            applyProjection,
          })
        } else {
          await applyProjection()
        }
      }
      let graceInterviewsCounted: 0 | 1 = 0
      if (projectionApplied) {
        graceInterviewsCounted =
          await settleConsumedSubscriptionGraceAgainstCycle({
            cycle,
            draft,
            completedAt,
            session,
            port: graceSettlementPort,
          })
      }
      const analyticsDraft = graceInterviewsCounted === 1
        ? {
            ...draft,
            interviewLimit: draft.interviewLimit - 1,
          }
        : draft
      await advanceEntitlementFence({
        fulfillment,
        cycle,
        draft,
        disposition,
        reason:
          `${decision.lineage}:${decision.reason}`,
        completedAt,
        session,
      })
      await renewalProducer
        ?.appendSubscriptionRenewedInSession(
          () => subscriptionActivationEvidence({
            cycle,
            draft: analyticsDraft,
            occurredAt: completedAt,
            priorCycleAuthority: 'captured',
            session,
          }),
          session,
        )
      if (disposition === 'financial_review') {
        await markPlanChangeFinancialReview({
          request: planChange,
          reason:
            `Captured cycle requires financial review: ${decision.reason}`,
          session,
        })
      }
      if (projectionApplied) {
        await fulfillInitialIntent(draft, session)
        await producer
          ?.appendSubscriptionEntitlementActivatedInSession(
            () => subscriptionActivationEvidence({
              cycle,
              draft: analyticsDraft,
              occurredAt: completedAt,
              priorCycleAuthority: 'projected',
              session,
            }),
            session,
          )
      }

      result = {
        checkoutIntentId: draft.checkoutIntentId.toString(),
        localSubscriptionId:
          local.subscription._id.toString(),
        subscriptionCycleId: cycle._id.toString(),
        fulfillmentId: fulfillment._id.toString(),
        periodKey: draft.periodKey,
        reused: false,
        projectionApplied,
        projectionDisposition: disposition,
        requiresFinancialReview:
          disposition === 'financial_review',
        ...(disposition === 'financial_review'
          ? {
              projectionReviewReason:
                `${decision.lineage}:${decision.reason}`,
            }
          : {}),
      }
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  if (!result) {
    throw failure(
      'persistence_conflict',
      'Cycle transaction completed without a result',
    )
  }
  return result
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

export const mongoSubscriptionCycleFulfillmentStore:
SubscriptionCycleFulfillmentStore = {
  async loadOriginalIntent(input) {
    await connectDB()
    return loadMongoOriginalIntent(input)
  },

  async persistCycle(
    input,
    producer,
    renewalProducer,
    graceSettlementPort,
  ) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await persistMongoCycleOnce(
          input,
          producer,
          renewalProducer,
          graceSettlementPort,
        )
      } catch (error) {
        if (attempt === 0 && duplicateKeyError(error)) continue
        throw error
      }
    }
    throw failure(
      'persistence_conflict',
      'Cycle persistence exhausted duplicate recovery',
    )
  },
}

/**
 * Validates a signature-derived reference set against freshly server-fetched
 * normalized Razorpay entities, then atomically applies one paid billing cycle.
 * It does not fetch the provider, generate an invoice, notify the customer, or
 * enable any payment/entitlement runtime switch.
 */
export async function fulfillSubscriptionCycle(
  input: FulfillSubscriptionCycleInput,
  dependencies: SubscriptionCycleFulfillmentDependencies = {},
): Promise<SubscriptionCycleFulfillmentResult> {
  const completedAt = dependencies.now?.() ?? new Date()
  if (!validDate(completedAt)) {
    throw failure(
      'invalid_input',
      'Fulfillment completion time is invalid',
    )
  }
  const entities = normalizedServerEntities(input)
  return fulfillValidatedSubscriptionCycle({
    ...entities,
    providerMode: input.providerMode,
    expectedSubscriptionId:
      input.references.razorpaySubscriptionId,
    completedAt,
    dependencies,
    validateReferences: () => requireExactProviderReferences({
      providerMode: input.providerMode,
      references: input.references,
      ...entities,
    }).razorpayOrderId,
    persistenceMessage:
      'Subscription cycle could not be persisted coherently',
  })
}

/**
 * Clean provider-observation input for exact invoice reconciliation. Every
 * identifier comes from a local correlation plus a server fetch; there is no
 * webhook inbox identity because reconciliation is not a webhook.
 */
export interface SubscriptionCycleProviderObservationInput {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  razorpayPaymentId: string
  razorpayInvoiceId: string
  razorpayOrderId: string
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
}

function normalizedSubscriptionCycleProviderObservation(
  input: SubscriptionCycleProviderObservationInput,
): {
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
} {
  try {
    return {
      payment: RazorpayPaymentDtoSchema.parse(input.payment),
      invoice: RazorpayInvoiceDtoSchema.parse(input.invoice),
      subscription:
        RazorpaySubscriptionDtoSchema.parse(input.subscription),
    }
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched Razorpay observation entities are not normalized',
      error,
    )
  }
}

function requireExactSubscriptionCycleProviderObservation(input: {
  observation: SubscriptionCycleProviderObservationInput
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  subscription: RazorpaySubscriptionDto
}): void {
  const {
    observation,
    payment,
    invoice,
    subscription,
  } = input
  if (
    payment.providerMode !== observation.providerMode ||
    invoice.providerMode !== observation.providerMode ||
    subscription.providerMode !== observation.providerMode ||
    payment.id !== observation.razorpayPaymentId ||
    payment.invoiceId !== observation.razorpayInvoiceId ||
    payment.orderId !== observation.razorpayOrderId ||
    payment.subscriptionId !== observation.razorpaySubscriptionId ||
    invoice.id !== observation.razorpayInvoiceId ||
    invoice.paymentId !== observation.razorpayPaymentId ||
    invoice.orderId !== observation.razorpayOrderId ||
    invoice.subscriptionId !== observation.razorpaySubscriptionId ||
    subscription.id !== observation.razorpaySubscriptionId
  ) {
    throw failure(
      'reference_conflict',
      'Provider observation entities do not share exact references',
    )
  }
}

/**
 * Reuses the paid-cycle transaction without constructing a webhook-shaped
 * value or inventing any event/inbox provenance.
 */
export async function fulfillSubscriptionCycleProviderObservation(
  input: SubscriptionCycleProviderObservationInput,
  dependencies: SubscriptionCycleFulfillmentDependencies = {},
): Promise<SubscriptionCycleFulfillmentResult> {
  const completedAt = dependencies.now?.() ?? new Date()
  if (!validDate(completedAt)) {
    throw failure(
      'invalid_input',
      'Fulfillment completion time is invalid',
    )
  }
  const entities =
    normalizedSubscriptionCycleProviderObservation(input)
  return fulfillValidatedSubscriptionCycle({
    ...entities,
    providerMode: input.providerMode,
    expectedSubscriptionId: input.razorpaySubscriptionId,
    completedAt,
    dependencies,
    validateReferences: () => {
      requireExactSubscriptionCycleProviderObservation({
        observation: input,
        ...entities,
      })
      return input.razorpayOrderId
    },
    persistenceMessage:
      'Subscription cycle observation could not be persisted coherently',
  })
}
