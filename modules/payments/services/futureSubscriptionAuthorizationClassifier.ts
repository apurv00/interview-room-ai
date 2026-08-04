import type {
  RazorpayPaymentDto,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'

export const RAZORPAY_MANDATE_AUTHORIZATION_AMOUNT_PAISE = 500 as const

export const FUTURE_SUBSCRIPTION_AUTHORIZATION_DECISIONS = [
  'accept_authorization',
  'retry',
  'authentication_failed',
  'review',
] as const
export type FutureSubscriptionAuthorizationDecisionKind =
  (typeof FUTURE_SUBSCRIPTION_AUTHORIZATION_DECISIONS)[number]

export const FUTURE_SUBSCRIPTION_AUTHORIZATION_ACCEPT_REASON_CODES = [
  'authorization_tuple_verified',
] as const
export type FutureSubscriptionAuthorizationAcceptReasonCode =
  (typeof FUTURE_SUBSCRIPTION_AUTHORIZATION_ACCEPT_REASON_CODES)[number]

export const FUTURE_SUBSCRIPTION_AUTHORIZATION_RETRY_REASON_CODES = [
  'provider_entities_created',
  'payment_created',
  'subscription_created',
] as const
export type FutureSubscriptionAuthorizationRetryReasonCode =
  (typeof FUTURE_SUBSCRIPTION_AUTHORIZATION_RETRY_REASON_CODES)[number]

export const FUTURE_SUBSCRIPTION_AUTHENTICATION_FAILED_REASON_CODES = [
  'payment_failed_subscription_created',
] as const
export type FutureSubscriptionAuthenticationFailedReasonCode =
  (typeof FUTURE_SUBSCRIPTION_AUTHENTICATION_FAILED_REASON_CODES)[number]

export const FUTURE_SUBSCRIPTION_AUTHORIZATION_REVIEW_REASON_CODES = [
  'invalid_expectation',
  'invalid_observation_time',
  'authorization_window_expired',
  'payment_provider_mode_mismatch',
  'subscription_provider_mode_mismatch',
  'payment_id_mismatch',
  'subscription_id_mismatch',
  'payment_amount_mismatch',
  'payment_currency_mismatch',
  'payment_subscription_id_mismatch',
  'subscription_plan_id_mismatch',
  'subscription_offer_id_mismatch',
  'subscription_total_count_mismatch',
  'subscription_notes_mismatch',
  'subscription_start_at_mismatch',
  'subscription_authorization_expiry_mismatch',
  'subscription_charge_at_mismatch',
  'subscription_paid_count_mismatch',
  'subscription_remaining_count_mismatch',
  'subscription_current_period_present',
  'payment_provider_evidence_missing',
  'payment_provider_evidence_hybrid',
  'authorization_payment_captured_unrefunded',
  'authorization_payment_partially_refunded',
  'authorization_payment_fully_refunded_unproven',
  'provider_status_contradiction',
] as const
export type FutureSubscriptionAuthorizationReviewReasonCode =
  (typeof FUTURE_SUBSCRIPTION_AUTHORIZATION_REVIEW_REASON_CODES)[number]

export const FUTURE_SUBSCRIPTION_AUTHORIZATION_REASON_CODES = [
  ...FUTURE_SUBSCRIPTION_AUTHORIZATION_ACCEPT_REASON_CODES,
  ...FUTURE_SUBSCRIPTION_AUTHORIZATION_RETRY_REASON_CODES,
  ...FUTURE_SUBSCRIPTION_AUTHENTICATION_FAILED_REASON_CODES,
  ...FUTURE_SUBSCRIPTION_AUTHORIZATION_REVIEW_REASON_CODES,
] as const
export type FutureSubscriptionAuthorizationReasonCode =
  (typeof FUTURE_SUBSCRIPTION_AUTHORIZATION_REASON_CODES)[number]

export type FutureSubscriptionCheckoutPurpose =
  | 'replacement'
  | 'resubscribe'
export type FutureSubscriptionLeaseLane = 'a' | 'b'

export interface FutureSubscriptionAuthorizationExpectation {
  providerMode: ProviderMode
  paymentId: string
  subscriptionId: string
  planId: string
  offerId?: string
  checkoutIntentId: string
  checkoutReceipt: string
  catalogVersion: string
  purpose: FutureSubscriptionCheckoutPurpose
  leaseLane: FutureSubscriptionLeaseLane
  planChangeRequestId: string
  startAtEpochSeconds: number
  authorizationExpiresAtEpochSeconds: number
  totalCount: number
}

export interface FutureSubscriptionAuthorizationClassifierInput {
  expectation: Readonly<FutureSubscriptionAuthorizationExpectation>
  payment: Readonly<RazorpayPaymentDto>
  subscription: Readonly<RazorpaySubscriptionDto>
  observedAtEpochSeconds: number
}

export type FutureSubscriptionAuthorizationDecision =
  | {
      decision: 'accept_authorization'
      reason: FutureSubscriptionAuthorizationAcceptReasonCode
    }
  | {
      decision: 'retry'
      reason: FutureSubscriptionAuthorizationRetryReasonCode
    }
  | {
      decision: 'authentication_failed'
      reason: FutureSubscriptionAuthenticationFailedReasonCode
    }
  | {
      decision: 'review'
      reason: FutureSubscriptionAuthorizationReviewReasonCode
    }

type ReviewDecision = Extract<
  FutureSubscriptionAuthorizationDecision,
  { decision: 'review' }
>

const PROVIDER_ID_PATTERNS = {
  payment: /^pay_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
  plan: /^plan_[A-Za-z0-9]+$/,
  offer: /^offer_[A-Za-z0-9]+$/,
} as const
const MONGODB_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function validExpectation(
  expectation: Readonly<FutureSubscriptionAuthorizationExpectation>,
): boolean {
  return (
    (expectation.providerMode === 'test' ||
      expectation.providerMode === 'live') &&
    PROVIDER_ID_PATTERNS.payment.test(expectation.paymentId) &&
    PROVIDER_ID_PATTERNS.subscription.test(expectation.subscriptionId) &&
    PROVIDER_ID_PATTERNS.plan.test(expectation.planId) &&
    (
      expectation.offerId === undefined ||
      PROVIDER_ID_PATTERNS.offer.test(expectation.offerId)
    ) &&
    MONGODB_OBJECT_ID_PATTERN.test(expectation.checkoutIntentId) &&
    expectation.checkoutReceipt.length >= 1 &&
    expectation.checkoutReceipt.length <= 40 &&
    expectation.catalogVersion.length >= 1 &&
    expectation.catalogVersion.length <= 100 &&
    (
      expectation.purpose === 'replacement' ||
      expectation.purpose === 'resubscribe'
    ) &&
    (
      expectation.leaseLane === 'a' ||
      expectation.leaseLane === 'b'
    ) &&
    MONGODB_OBJECT_ID_PATTERN.test(expectation.planChangeRequestId) &&
    isPositiveSafeInteger(expectation.startAtEpochSeconds) &&
    isPositiveSafeInteger(
      expectation.authorizationExpiresAtEpochSeconds,
    ) &&
    expectation.authorizationExpiresAtEpochSeconds <
      expectation.startAtEpochSeconds &&
    isPositiveSafeInteger(expectation.totalCount)
  )
}

function review(
  reason: FutureSubscriptionAuthorizationReviewReasonCode,
): ReviewDecision {
  return { decision: 'review', reason }
}

function exactSubscriptionNotes(
  expectation: Readonly<FutureSubscriptionAuthorizationExpectation>,
  actual: RazorpaySubscriptionDto['notes'],
): boolean {
  const expected = {
    checkout_receipt: expectation.checkoutReceipt,
    checkout_intent_id: expectation.checkoutIntentId,
    catalog_version: expectation.catalogVersion,
    checkout_purpose: expectation.purpose,
    subscription_lease_lane: expectation.leaseLane,
    plan_change_request_id: expectation.planChangeRequestId,
  } as const
  const expectedKeys = Object.keys(expected)
  const actualKeys = Object.keys(actual)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => actual[key] === expected[
      key as keyof typeof expected
    ])
  )
}

function paymentEvidenceReview(
  payment: Readonly<RazorpayPaymentDto>,
): ReviewDecision | null {
  const evidence = payment.providerEvidence
  if (
    evidence === undefined ||
    evidence.amountRefundedPaise === undefined ||
    evidence.refundStatus === undefined ||
    evidence.amountCapturedPaise === undefined
  ) {
    return review('payment_provider_evidence_missing')
  }

  if (payment.amountRefundedPaise !== evidence.amountRefundedPaise) {
    return review('payment_provider_evidence_hybrid')
  }

  const refundedPaise = evidence.amountRefundedPaise
  const capturedPaise = evidence.amountCapturedPaise
  const refundStatus = evidence.refundStatus
  const hasPartialRefund =
    refundStatus === 'partial' ||
    (
      refundedPaise > 0 &&
      refundedPaise < RAZORPAY_MANDATE_AUTHORIZATION_AMOUNT_PAISE
    )
  if (hasPartialRefund) {
    return review('authorization_payment_partially_refunded')
  }

  const isCanonicalFullRefund =
    payment.status === 'refunded' &&
    payment.captured === true &&
    capturedPaise === RAZORPAY_MANDATE_AUTHORIZATION_AMOUNT_PAISE &&
    refundedPaise === RAZORPAY_MANDATE_AUTHORIZATION_AMOUNT_PAISE &&
    refundStatus === 'full'
  if (isCanonicalFullRefund) {
    return review('authorization_payment_fully_refunded_unproven')
  }

  const hasNoRefund =
    refundedPaise === 0 &&
    refundStatus === null
  const hasCapture =
    payment.captured ||
    payment.status === 'captured' ||
    capturedPaise > 0
  if (hasNoRefund && hasCapture) {
    return review('authorization_payment_captured_unrefunded')
  }

  const isCanonicalUncapturedEvidence =
    payment.captured === false &&
    capturedPaise === 0 &&
    refundedPaise === 0 &&
    refundStatus === null
  return isCanonicalUncapturedEvidence
    ? null
    : review('payment_provider_evidence_hybrid')
}

/**
 * Classifies only server-fetched provider evidence. The caller must verify the
 * Razorpay checkout HMAC before invoking this function. This pure classifier
 * performs no capture/refund calls and creates no payment or entitlement state.
 */
export function classifyFutureSubscriptionAuthorizationEvidence(
  input: FutureSubscriptionAuthorizationClassifierInput,
): FutureSubscriptionAuthorizationDecision {
  const {
    expectation,
    payment,
    subscription,
    observedAtEpochSeconds,
  } = input

  if (!validExpectation(expectation)) {
    return review('invalid_expectation')
  }
  if (
    !Number.isSafeInteger(observedAtEpochSeconds) ||
    observedAtEpochSeconds < 0
  ) {
    return review('invalid_observation_time')
  }
  if (
    observedAtEpochSeconds >=
      expectation.authorizationExpiresAtEpochSeconds
  ) {
    return review('authorization_window_expired')
  }
  if (payment.providerMode !== expectation.providerMode) {
    return review('payment_provider_mode_mismatch')
  }
  if (subscription.providerMode !== expectation.providerMode) {
    return review('subscription_provider_mode_mismatch')
  }
  if (payment.id !== expectation.paymentId) {
    return review('payment_id_mismatch')
  }
  if (subscription.id !== expectation.subscriptionId) {
    return review('subscription_id_mismatch')
  }
  if (
    payment.amountPaise !==
      RAZORPAY_MANDATE_AUTHORIZATION_AMOUNT_PAISE
  ) {
    return review('payment_amount_mismatch')
  }
  if (payment.currency !== 'INR') {
    return review('payment_currency_mismatch')
  }
  if (
    payment.subscriptionId !== undefined &&
    payment.subscriptionId !== expectation.subscriptionId
  ) {
    return review('payment_subscription_id_mismatch')
  }
  if (subscription.planId !== expectation.planId) {
    return review('subscription_plan_id_mismatch')
  }
  if (subscription.offerId !== expectation.offerId) {
    return review('subscription_offer_id_mismatch')
  }
  if (subscription.totalCount !== expectation.totalCount) {
    return review('subscription_total_count_mismatch')
  }
  if (!exactSubscriptionNotes(expectation, subscription.notes)) {
    return review('subscription_notes_mismatch')
  }
  if (
    subscription.startAtEpochSeconds !==
      expectation.startAtEpochSeconds
  ) {
    return review('subscription_start_at_mismatch')
  }
  if (
    subscription.authorizationExpiresAtEpochSeconds !==
      expectation.authorizationExpiresAtEpochSeconds
  ) {
    return review('subscription_authorization_expiry_mismatch')
  }
  if (
    subscription.chargeAtEpochSeconds !==
      expectation.startAtEpochSeconds
  ) {
    return review('subscription_charge_at_mismatch')
  }
  if (subscription.paidCount !== 0) {
    return review('subscription_paid_count_mismatch')
  }
  if (subscription.remainingCount !== expectation.totalCount) {
    return review('subscription_remaining_count_mismatch')
  }
  if (
    subscription.currentStartEpochSeconds !== undefined ||
    subscription.currentEndEpochSeconds !== undefined
  ) {
    return review('subscription_current_period_present')
  }

  const evidenceDecision = paymentEvidenceReview(payment)
  if (evidenceDecision) return evidenceDecision

  const hasContradictoryLifecycleEvidence =
    subscription.endedAtEpochSeconds !== undefined ||
    subscription.hasScheduledChanges === true ||
    subscription.scheduledChangeAtEpochSeconds !== undefined ||
    (
      payment.status !== 'failed' &&
      payment.error !== undefined
    )
  if (hasContradictoryLifecycleEvidence) {
    return review('provider_status_contradiction')
  }

  if (
    payment.status === 'failed' &&
    subscription.status === 'created'
  ) {
    return {
      decision: 'authentication_failed',
      reason: 'payment_failed_subscription_created',
    }
  }

  if (
    payment.status === 'created' &&
    subscription.status === 'created'
  ) {
    return {
      decision: 'retry',
      reason: 'provider_entities_created',
    }
  }
  if (
    payment.status === 'created' &&
    subscription.status === 'authenticated'
  ) {
    return { decision: 'retry', reason: 'payment_created' }
  }
  if (
    payment.status === 'authorized' &&
    subscription.status === 'created'
  ) {
    return { decision: 'retry', reason: 'subscription_created' }
  }
  if (
    payment.status === 'authorized' &&
    subscription.status === 'authenticated'
  ) {
    return {
      decision: 'accept_authorization',
      reason: 'authorization_tuple_verified',
    }
  }

  return review('provider_status_contradiction')
}
