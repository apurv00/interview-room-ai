import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  CHECKOUT_INTENT_STATUSES,
  CheckoutIntent,
  type CheckoutIntentKind,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import {
  PAYMENT_ATTEMPT_STATUSES,
  PaymentAttempt,
  type PaymentAttemptStatus,
} from '../models/PaymentAttempt'
import {
  SUBSCRIPTION_STATUSES,
  Subscription,
  type SubscriptionSource,
  type SubscriptionStatus,
} from '../models/Subscription'
import type { InrPaise } from '../lib/money'
import {
  RazorpayOrderDtoSchema,
  RazorpayPaymentDtoSchema,
  RazorpaySubscriptionDtoSchema,
  type RazorpayOrderDto,
  type RazorpayPaymentDto,
  type RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import type {
  PaymentStateEffectInput,
  TrustedWebhookSubscription,
} from './webhookDomainDispatchService'
import type {
  CapturedCommercialAnalyticsEvidence,
} from './capturedCheckoutVerificationService'
export const PAYMENT_STATE_PERSISTENCE_ERROR_CODES = [
  'invalid_input',
  'reference_conflict',
  'local_context_missing',
  'local_context_conflict',
  'intent_conflict',
  'payment_state_conflict',
  'persistence_conflict',
] as const
export type PaymentStatePersistenceErrorCode =
  (typeof PAYMENT_STATE_PERSISTENCE_ERROR_CODES)[number]
export class PaymentStatePersistenceError extends Error {
  readonly code: PaymentStatePersistenceErrorCode

  constructor(
    code: PaymentStatePersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PaymentStatePersistenceError'
    this.code = code
  }
}
export interface NormalizedPaymentStateSnapshot {
  providerMode: ProviderMode
  id: string
  orderId?: string
  subscriptionId?: string
  invoiceId?: string
  amountPaise: InrPaise
  amountRefundedPaise: 0
  currency: 'INR'
  status: 'authorized' | 'failed'
  captured: false
  createdAtEpochSeconds: number
}
export interface PaymentStateIntent {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  planKey?: 'plus' | 'pro'
  catalogVersion?: string
  listPricePaise?: number
  discountPaise?: number
  payablePaise?: number
  renewalPricePaise?: number
  couponCampaignId?: mongoose.Types.ObjectId
  currency?: 'INR'
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  receipt: string
}
export interface PaymentStateLocalSubscription {
  id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  status: SubscriptionStatus
  source: SubscriptionSource
}
export interface StoredPaymentStateAttempt {
  id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: PaymentAttemptStatus
  amountPaise: InrPaise
  currency: 'INR'
  providerSnapshot: unknown
  lastSyncedAt: Date
}
export interface PaymentStateAttemptDraft {
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: 'authorized' | 'failed'
  amountPaise: InrPaise
  currency: 'INR'
  providerSnapshot: NormalizedPaymentStateSnapshot
  lastSyncedAt: Date
}
export interface TransitionPaymentStateAttemptInput {
  attempt: StoredPaymentStateAttempt
  status: 'authorized' | 'failed'
  providerSnapshot: NormalizedPaymentStateSnapshot
  lastSyncedAt: Date
}
export interface PaymentStatePersistenceTransaction {
  loadIntent(
    intentId: mongoose.Types.ObjectId,
  ): Promise<PaymentStateIntent | null>
  loadSubscription(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }): Promise<PaymentStateLocalSubscription | null>
  loadAttempt(input: {
    providerMode: ProviderMode
    razorpayPaymentId: string
  }): Promise<StoredPaymentStateAttempt | null>
  createAttempt(
    draft: PaymentStateAttemptDraft,
  ): Promise<mongoose.Types.ObjectId>
  transitionAttempt(
    input: TransitionPaymentStateAttemptInput,
  ): Promise<boolean>
  appendPaymentStateCommercialAnalytics?(
    producer: PaymentStateCommercialAnalyticsProducer,
    evidence: () => PaymentStateCommercialAnalyticsEvidence,
  ): Promise<void>
}
export interface PaymentStateCommercialAnalyticsEvidence
  extends CapturedCommercialAnalyticsEvidence {
  readonly eventName: 'payment_failed' | 'activation_pending'
  readonly observationSource: 'signed_webhook' | 'provider_fetch'
  readonly lifecycleStage:
    | 'one_time_payment' | 'subscription_payment' | 'subscription_mandate'
  readonly lifecycleReason:
    | 'customer_action_required' | 'instrument_declined'
    | 'insufficient_funds' | 'provider_risk' | 'provider_error'
    | 'unknown_provider_failure' | 'awaiting_capture'
}
export interface PaymentStateCommercialAnalyticsProducer {
  appendPaymentStateTransitionInSession(
    evidence: () => PaymentStateCommercialAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}
export interface PaymentStatePersistenceStore {
  runTransaction<T>(
    work: (
      transaction: PaymentStatePersistenceTransaction,
    ) => Promise<T>,
    producer?: PaymentStateCommercialAnalyticsProducer,
  ): Promise<T>
}
export interface PaymentStatePersistenceDependencies {
  store?: PaymentStatePersistenceStore
  commercialAnalyticsProducer?: PaymentStateCommercialAnalyticsProducer
  now?: () => Date
}
export interface PaymentStatePersistenceResult {
  outcome: 'handled'
  operationKey: string
  attemptId: string
  checkoutIntentId: string
  razorpayPaymentId: string
  paymentStatus: PaymentAttemptStatus
  reused: boolean
  stateChanged: boolean
  supersededByLaterState: boolean
}
interface PaymentStateBinding {
  intent: PaymentStateIntent
  expectedSubscription?: PaymentStateLocalSubscription
  remoteSubscription?: RazorpaySubscriptionDto
}
interface ValidatedPaymentStateEffect {
  draft: PaymentStateAttemptDraft
  binding: PaymentStateBinding
  failureReason:
    PaymentStateCommercialAnalyticsEvidence['lifecycleReason']
}
const SUPERSEDING_ATTEMPT_STATUSES:
readonly PaymentAttemptStatus[] = [
  'captured',
  'refunded',
  'disputed',
  'review',
]
function failure(
  code: PaymentStatePersistenceErrorCode,
  message: string,
  cause?: unknown,
): PaymentStatePersistenceError {
  return new PaymentStatePersistenceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}
function isObjectId(
  value: unknown,
): value is mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId
}
function sameObjectId(
  left: mongoose.Types.ObjectId,
  right: mongoose.Types.ObjectId,
): boolean {
  return left.equals(right)
}
function sameOptional(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right
}
function validObservedAt(value: Date): boolean {
  return Number.isFinite(value.getTime())
}
function assertEffectEnvelope(
  input: PaymentStateEffectInput,
): RazorpayPaymentDto & {
  status: 'authorized' | 'failed'
  captured: false
  amountRefundedPaise: 0
} {
  if (
    (
      input.eventType !== 'payment.authorized' &&
      input.eventType !== 'payment.failed'
    ) ||
    !mongoose.isValidObjectId(input.inboxEventId)
  ) {
    throw failure(
      'invalid_input',
      'Payment state effect envelope is invalid',
    )
  }

  let payment: RazorpayPaymentDto
  try {
    payment = RazorpayPaymentDtoSchema.parse(input.payment)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched payment is not a normalized Razorpay payment',
      error,
    )
  }

  if (
    payment.providerMode !== input.providerMode ||
    payment.id !== input.razorpayPaymentId ||
    !sameOptional(payment.orderId, input.razorpayOrderId) ||
    !sameOptional(
      payment.subscriptionId,
      input.razorpaySubscriptionId,
    ) ||
    !sameOptional(payment.invoiceId, input.razorpayInvoiceId)
  ) {
    throw failure(
      'reference_conflict',
      'Server-fetched payment does not match the verified effect envelope',
    )
  }

  if (
    (payment.status !== 'authorized' && payment.status !== 'failed') ||
    payment.captured !== false ||
    payment.amountRefundedPaise !== 0 ||
    payment.amountPaise <= 0
  ) {
    throw failure(
      'payment_state_conflict',
      'Payment state effect lacks an unreversed authorized or failed attempt',
    )
  }

  return payment as RazorpayPaymentDto & {
    status: 'authorized' | 'failed'
    captured: false
    amountRefundedPaise: 0
  }
}

function assertIntentShape(intent: PaymentStateIntent): void {
  if (
    !isObjectId(intent.id) ||
    !isObjectId(intent.userId) ||
    !CHECKOUT_INTENT_STATUSES.includes(intent.status) ||
    typeof intent.receipt !== 'string' ||
    intent.receipt.trim().length < 1 ||
    intent.receipt.length > 40 ||
    (
      intent.kind === 'subscription'
        ? (
            (intent.planKey !== 'plus' && intent.planKey !== 'pro') ||
            typeof intent.catalogVersion !== 'string' ||
            intent.catalogVersion.trim().length === 0
          )
        : (
            !Number.isSafeInteger(intent.payablePaise) ||
            (intent.payablePaise ?? -1) < 0 ||
            intent.currency !== 'INR'
          )
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Checkout intent correlation is malformed',
    )
  }
}

type PaymentStateBindingObservation = Pick<
  PaymentStateEffectInput,
  'providerMode' | 'target'
>

function oneTimeBinding(input: {
  effect: PaymentStateBindingObservation
  payment: RazorpayPaymentDto & {
    status: 'authorized' | 'failed'
    captured: false
    amountRefundedPaise: 0
  }
}): PaymentStateBinding {
  const target = input.effect.target
  if (target.kind !== 'one_time_checkout') {
    throw failure(
      'local_context_conflict',
      'One-time binding received a subscription target',
    )
  }

  let order: RazorpayOrderDto
  try {
    order = RazorpayOrderDtoSchema.parse(target.order)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched one-time order is not normalized',
      error,
    )
  }

  const intent: PaymentStateIntent = {
    id: target.intent._id,
    userId: target.intent.userId,
    kind: target.intent.kind,
    providerMode: target.intent.providerMode,
    status: target.intent.status,
    payablePaise: target.intent.payablePaise,
    currency: target.intent.currency,
    razorpayOrderId: target.intent.razorpayOrderId,
    receipt: target.intent.receipt,
  }
  assertIntentShape(intent)

  if (
    (
      intent.kind !== 'single_interview' &&
      intent.kind !== 'premium_resume'
    ) ||
    intent.providerMode !== input.effect.providerMode ||
    !intent.razorpayOrderId ||
    order.providerMode !== input.effect.providerMode ||
    order.id !== intent.razorpayOrderId ||
    order.receipt !== intent.receipt ||
    order.currency !== intent.currency ||
    order.amountPaise !== intent.payablePaise ||
    order.amountPaidPaise + order.amountDuePaise !== order.amountPaise ||
    input.payment.orderId !== order.id ||
    input.payment.subscriptionId !== undefined ||
    input.payment.invoiceId !== undefined ||
    input.payment.currency !== intent.currency ||
    input.payment.amountPaise !== intent.payablePaise
  ) {
    throw failure(
      'local_context_conflict',
      'One-time payment, order, receipt, and checkout intent disagree',
    )
  }

  return { intent }
}

function targetLocalSubscription(
  subscription: TrustedWebhookSubscription,
): PaymentStateLocalSubscription {
  return {
    id: subscription._id,
    userId: subscription.userId,
    providerMode: subscription.providerMode,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    razorpayPlanId: subscription.razorpayPlanId,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    status: subscription.status,
    source: subscription.source,
  }
}

function assertSubscriptionShape(
  subscription: PaymentStateLocalSubscription,
): void {
  if (
    !isObjectId(subscription.id) ||
    !isObjectId(subscription.userId) ||
    (
      subscription.planKey !== 'plus' &&
      subscription.planKey !== 'pro'
    ) ||
    typeof subscription.catalogVersion !== 'string' ||
    subscription.catalogVersion.trim().length === 0 ||
    typeof subscription.razorpayPlanId !== 'string' ||
    subscription.razorpayPlanId.trim().length === 0 ||
    typeof subscription.razorpaySubscriptionId !== 'string' ||
    subscription.razorpaySubscriptionId.trim().length === 0 ||
    !SUBSCRIPTION_STATUSES.includes(subscription.status) ||
    subscription.source !== 'customer'
  ) {
    throw failure(
      'local_context_conflict',
      'Local subscription correlation is malformed',
    )
  }
}

function subscriptionBinding(input: {
  effect: PaymentStateBindingObservation
  payment: RazorpayPaymentDto & {
    status: 'authorized' | 'failed'
    captured: false
    amountRefundedPaise: 0
  }
}): PaymentStateBinding {
  const target = input.effect.target
  if (target.kind !== 'subscription') {
    throw failure(
      'local_context_conflict',
      'Subscription binding received a one-time target',
    )
  }

  let remote: RazorpaySubscriptionDto
  try {
    remote = RazorpaySubscriptionDtoSchema.parse(target.subscription)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched subscription is not normalized',
      error,
    )
  }

  const checkout = target.context.checkout
  if (!checkout) {
    throw failure(
      'local_context_missing',
      'Subscription payment lacks its original checkout intent',
    )
  }
  if (
    input.payment.invoiceId === undefined &&
    (
      checkout.purpose === 'replacement' ||
      checkout.purpose === 'resubscribe'
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Future mandate authorization requires lifecycle persistence',
    )
  }

  const intent: PaymentStateIntent = {
    id: checkout._id,
    userId: checkout.userId,
    kind: 'subscription',
    providerMode: checkout.providerMode,
    status: checkout.status,
    planKey: checkout.planKey,
    catalogVersion: checkout.catalogVersion,
    razorpaySubscriptionId: checkout.razorpaySubscriptionId,
    receipt: checkout.receipt,
  }
  assertIntentShape(intent)

  const expectedSubscription = target.context.subscription
    ? targetLocalSubscription(target.context.subscription)
    : undefined
  if (expectedSubscription) {
    assertSubscriptionShape(expectedSubscription)
  }

  if (
    intent.providerMode !== input.effect.providerMode ||
    input.payment.subscriptionId !== intent.razorpaySubscriptionId ||
    remote.providerMode !== input.effect.providerMode ||
    remote.id !== intent.razorpaySubscriptionId ||
    remote.notes.checkout_receipt !== intent.receipt ||
    remote.paidCount > remote.totalCount ||
    remote.remainingCount > remote.totalCount ||
    (
      (remote.currentStartEpochSeconds === undefined) !==
      (remote.currentEndEpochSeconds === undefined)
    ) ||
    (
      remote.currentStartEpochSeconds !== undefined &&
      remote.currentEndEpochSeconds !== undefined &&
      remote.currentEndEpochSeconds <= remote.currentStartEpochSeconds
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Subscription payment, receipt, and remote subscription disagree',
    )
  }

  if (
    expectedSubscription &&
    (
      !sameObjectId(expectedSubscription.userId, intent.userId) ||
      expectedSubscription.providerMode !== intent.providerMode ||
      expectedSubscription.planKey !== intent.planKey ||
      expectedSubscription.catalogVersion !== intent.catalogVersion ||
      expectedSubscription.razorpaySubscriptionId !==
        intent.razorpaySubscriptionId ||
      expectedSubscription.razorpayPlanId !== remote.planId
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Subscription checkout and local subscription disagree',
    )
  }

  // A recurring payment is deliberately not compared with the original
  // checkout payable. Its invoice/cycle is authoritative only in the separate
  // subscription-cycle fulfillment service.
  return {
    intent,
    expectedSubscription,
    remoteSubscription: remote,
  }
}

function normalizedSnapshot(
  payment: RazorpayPaymentDto & {
    status: 'authorized' | 'failed'
    captured: false
    amountRefundedPaise: 0
  },
): NormalizedPaymentStateSnapshot {
  return {
    providerMode: payment.providerMode,
    id: payment.id,
    ...(payment.orderId ? { orderId: payment.orderId } : {}),
    ...(payment.subscriptionId
      ? { subscriptionId: payment.subscriptionId }
      : {}),
    ...(payment.invoiceId ? { invoiceId: payment.invoiceId } : {}),
    amountPaise: payment.amountPaise,
    amountRefundedPaise: 0,
    currency: 'INR',
    status: payment.status,
    captured: false,
    createdAtEpochSeconds: payment.createdAtEpochSeconds,
  }
}

function analyticsFailureReason(
  payment: RazorpayPaymentDto,
): PaymentStateCommercialAnalyticsEvidence['lifecycleReason'] {
  if (payment.status !== 'failed') return 'awaiting_capture'
  const error = payment.error
  const tokens = [
    error?.code, error?.reason, error?.source, error?.step,
  ].filter(Boolean).join(' ').toLowerCase()
  if (!tokens) return 'unknown_provider_failure'
  if (/insufficient|balance/.test(tokens)) return 'insufficient_funds'
  if (/risk|fraud/.test(tokens)) return 'provider_risk'
  if (/auth|otp|3d|customer/.test(tokens)) {
    return 'customer_action_required'
  }
  if (/declin|instrument|card|bank/.test(tokens)) {
    return 'instrument_declined'
  }
  return 'provider_error'
}

function validateEffect(
  input: PaymentStateEffectInput,
  observedAt: Date,
): ValidatedPaymentStateEffect {
  if (!validObservedAt(observedAt)) {
    throw failure('invalid_input', 'Payment observation time is invalid')
  }
  const payment = assertEffectEnvelope(input)
  const binding = payment.subscriptionId
    ? subscriptionBinding({ effect: input, payment })
    : oneTimeBinding({ effect: input, payment })
  return {
    binding,
    failureReason: analyticsFailureReason(payment),
    draft: {
      providerMode: input.providerMode,
      checkoutIntentId: binding.intent.id,
      razorpayPaymentId: payment.id,
      ...(payment.orderId
        ? { razorpayOrderId: payment.orderId }
        : {}),
      ...(payment.subscriptionId
        ? { razorpaySubscriptionId: payment.subscriptionId }
        : {}),
      ...(payment.invoiceId
        ? { razorpayInvoiceId: payment.invoiceId }
        : {}),
      userId: binding.intent.userId,
      status: payment.status,
      amountPaise: payment.amountPaise,
      currency: 'INR',
      providerSnapshot: normalizedSnapshot(payment),
      lastSyncedAt: observedAt,
    },
  }
}

function assertIntentUnchanged(input: {
  expected: PaymentStateIntent
  current: PaymentStateIntent | null
}): void {
  const { expected, current } = input
  if (!current) {
    throw failure(
      'intent_conflict',
      'Checkout intent disappeared before payment state persistence',
    )
  }
  assertIntentShape(current)
  if (
    !sameObjectId(current.id, expected.id) ||
    !sameObjectId(current.userId, expected.userId) ||
    current.kind !== expected.kind ||
    current.providerMode !== expected.providerMode ||
    current.planKey !== expected.planKey ||
    (
      expected.kind === 'subscription' &&
      current.catalogVersion !== expected.catalogVersion
    ) ||
    current.razorpayOrderId !== expected.razorpayOrderId ||
    current.razorpaySubscriptionId !==
      expected.razorpaySubscriptionId ||
    current.receipt !== expected.receipt ||
    (
      expected.kind !== 'subscription' &&
      (
        current.payablePaise !== expected.payablePaise ||
        current.currency !== expected.currency
      )
    )
  ) {
    throw failure(
      'intent_conflict',
      'Checkout intent changed before payment state persistence',
    )
  }
}

function assertSubscriptionUnchanged(input: {
  binding: PaymentStateBinding
  current: PaymentStateLocalSubscription | null
}): void {
  const remote = input.binding.remoteSubscription
  if (!remote) return
  const expected = input.binding.expectedSubscription
  const current = input.current
  if (!current) {
    if (expected) {
      throw failure(
        'local_context_conflict',
        'Local subscription disappeared before payment state persistence',
      )
    }
    return
  }
  assertSubscriptionShape(current)
  if (
    !sameObjectId(current.userId, input.binding.intent.userId) ||
    current.providerMode !== input.binding.intent.providerMode ||
    current.planKey !== input.binding.intent.planKey ||
    current.catalogVersion !== input.binding.intent.catalogVersion ||
    current.razorpaySubscriptionId !== remote.id ||
    current.razorpayPlanId !== remote.planId ||
    (
      expected !== undefined &&
      (
        !sameObjectId(current.id, expected.id) ||
        current.status !== expected.status ||
        current.source !== expected.source
      )
    )
  ) {
    throw failure(
      'local_context_conflict',
      'Local subscription changed before payment state persistence',
    )
  }
}

function assertAttemptCoherent(
  attempt: StoredPaymentStateAttempt,
  draft: PaymentStateAttemptDraft,
): void {
  if (
    !isObjectId(attempt.id) ||
    !isObjectId(attempt.checkoutIntentId) ||
    !isObjectId(attempt.userId) ||
    !PAYMENT_ATTEMPT_STATUSES.includes(attempt.status) ||
    attempt.providerMode !== draft.providerMode ||
    !sameObjectId(
      attempt.checkoutIntentId,
      draft.checkoutIntentId,
    ) ||
    attempt.razorpayPaymentId !== draft.razorpayPaymentId ||
    attempt.razorpayOrderId !== draft.razorpayOrderId ||
    attempt.razorpaySubscriptionId !==
      draft.razorpaySubscriptionId ||
    attempt.razorpayInvoiceId !== draft.razorpayInvoiceId ||
    !sameObjectId(attempt.userId, draft.userId) ||
    attempt.amountPaise !== draft.amountPaise ||
    attempt.currency !== draft.currency
  ) {
    throw failure(
      'persistence_conflict',
      'Existing payment attempt conflicts with verified payment state',
    )
  }
}

function exactSnapshot(
  value: unknown,
  expected: NormalizedPaymentStateSnapshot,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  const expectedRecord = expected as unknown as Record<string, unknown>
  const keys = Object.keys(snapshot).sort()
  const expectedKeys = Object.keys(expectedRecord).sort()
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => snapshot[key] === expectedRecord[key])
  )
}

function operationKey(draft: PaymentStateAttemptDraft): string {
  return [
    'payment-state',
    draft.providerMode,
    draft.razorpayPaymentId,
  ].join(':')
}

function handledResult(input: {
  draft: PaymentStateAttemptDraft
  attemptId: mongoose.Types.ObjectId
  paymentStatus: PaymentAttemptStatus
  reused: boolean
  stateChanged: boolean
  supersededByLaterState: boolean
}): PaymentStatePersistenceResult {
  return {
    outcome: 'handled',
    operationKey: operationKey(input.draft),
    attemptId: input.attemptId.toString(),
    checkoutIntentId: input.draft.checkoutIntentId.toString(),
    razorpayPaymentId: input.draft.razorpayPaymentId,
    paymentStatus: input.paymentStatus,
    reused: input.reused,
    stateChanged: input.stateChanged,
    supersededByLaterState: input.supersededByLaterState,
  }
}

async function appendStateAnalytics(input: {
  validated: ValidatedPaymentStateEffect
  intent: PaymentStateIntent
  attemptId: mongoose.Types.ObjectId
  transaction: PaymentStatePersistenceTransaction
  producer?: PaymentStateCommercialAnalyticsProducer
  observationSource: 'signed_webhook' | 'provider_fetch'
}): Promise<void> {
  if (!input.producer) return
  const { draft } = input.validated
  const intent = input.intent
  if (
    !input.transaction.appendPaymentStateCommercialAnalytics ||
    typeof intent.catalogVersion !== 'string' ||
    !Number.isSafeInteger(intent.listPricePaise) ||
    !Number.isSafeInteger(intent.discountPaise) ||
    !Number.isSafeInteger(intent.payablePaise)
  ) {
    throw failure(
      'persistence_conflict',
      'Payment state analytics lacks immutable transaction evidence',
    )
  }
  await input.transaction.appendPaymentStateCommercialAnalytics(
    input.producer,
    () => ({
      eventName: draft.status === 'failed'
        ? 'payment_failed'
        : 'activation_pending',
      observationSource: input.observationSource,
      lifecycleStage: intent.kind === 'subscription'
        ? draft.razorpayInvoiceId
          ? 'subscription_payment'
          : 'subscription_mandate'
        : 'one_time_payment',
      lifecycleReason: input.validated.failureReason,
      sourceEvidenceId: input.attemptId.toHexString(),
      correlationId: intent.id.toHexString(),
      subjectId: intent.userId.toHexString(),
      providerMode: draft.providerMode,
      occurredAt: draft.lastSyncedAt,
      checkoutKind: intent.kind,
      productKey: intent.kind === 'subscription'
        ? intent.planKey ?? null
        : intent.kind,
      catalogVersion: intent.catalogVersion ?? null,
      listPricePaise: intent.listPricePaise ?? null,
      discountPaise: intent.discountPaise ?? null,
      payablePaise: intent.payablePaise ?? -1,
      renewalPricePaise: intent.renewalPricePaise ?? null,
      couponCampaignId:
        intent.couponCampaignId?.toHexString() ?? null,
    }),
  )
}

async function persistInTransaction(input: {
  validated: ValidatedPaymentStateEffect
  transaction: PaymentStatePersistenceTransaction
  producer?: PaymentStateCommercialAnalyticsProducer
  observationSource: 'signed_webhook' | 'provider_fetch'
}): Promise<PaymentStatePersistenceResult> {
  const { binding, draft } = input.validated
  const currentIntent = await input.transaction.loadIntent(
    draft.checkoutIntentId,
  )
  assertIntentUnchanged({
    expected: binding.intent,
    current: currentIntent,
  })

  if (draft.razorpaySubscriptionId) {
    const currentSubscription =
      await input.transaction.loadSubscription({
        providerMode: draft.providerMode,
        razorpaySubscriptionId: draft.razorpaySubscriptionId,
      })
    assertSubscriptionUnchanged({
      binding,
      current: currentSubscription,
    })
  }

  const existing = await input.transaction.loadAttempt({
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  })
  if (!existing) {
    const attemptId = await input.transaction.createAttempt(draft)
    if (!isObjectId(attemptId)) {
      throw failure(
        'persistence_conflict',
        'Payment attempt creation returned an invalid identity',
      )
    }
    await appendStateAnalytics({
      ...input,
      intent: currentIntent as PaymentStateIntent,
      attemptId,
    })
    return handledResult({
      draft,
      attemptId,
      paymentStatus: draft.status,
      reused: false,
      stateChanged: true,
      supersededByLaterState: false,
    })
  }

  assertAttemptCoherent(existing, draft)
  if (SUPERSEDING_ATTEMPT_STATUSES.includes(existing.status)) {
    return handledResult({
      draft,
      attemptId: existing.id,
      paymentStatus: existing.status,
      reused: true,
      stateChanged: false,
      supersededByLaterState: true,
    })
  }

  if (existing.status === draft.status) {
    if (!exactSnapshot(existing.providerSnapshot, draft.providerSnapshot)) {
      throw failure(
        'persistence_conflict',
        'Repeated payment state has conflicting provider evidence',
      )
    }
    return handledResult({
      draft,
      attemptId: existing.id,
      paymentStatus: existing.status,
      reused: true,
      stateChanged: false,
      supersededByLaterState: false,
    })
  }

  if (existing.status === 'failed' && draft.status === 'authorized') {
    throw failure(
      'payment_state_conflict',
      'A failed payment attempt cannot regress to authorized',
    )
  }
  if (
    existing.status !== 'created' &&
    !(
      existing.status === 'authorized' &&
      draft.status === 'failed'
    )
  ) {
    throw failure(
      'payment_state_conflict',
      'Payment attempt transition is not supported',
    )
  }

  const transitioned = await input.transaction.transitionAttempt({
    attempt: existing,
    status: draft.status,
    providerSnapshot: draft.providerSnapshot,
    lastSyncedAt: draft.lastSyncedAt,
  })
  if (!transitioned) {
    throw failure(
      'persistence_conflict',
      'Payment attempt changed during compare-and-set persistence',
    )
  }
  await appendStateAnalytics({
    ...input,
    intent: currentIntent as PaymentStateIntent,
    attemptId: existing.id,
  })
  return handledResult({
    draft,
    attemptId: existing.id,
    paymentStatus: draft.status,
    reused: true,
    stateChanged: true,
    supersededByLaterState: false,
  })
}

interface LeanIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  quoteSnapshot: {
    listPricePaise: number
    discountPaise: number
    payablePaise: number
    renewalPricePaise?: number
    couponCampaignId?: mongoose.Types.ObjectId
    currency: 'INR'
  }
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  receipt: string
}

interface LeanSubscription {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  status: SubscriptionStatus
  source: SubscriptionSource
}

interface LeanAttempt {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: PaymentAttemptStatus
  amountPaise: InrPaise
  currency: 'INR'
  providerSnapshot: unknown
  lastSyncedAt: Date
}

function toIntent(intent: LeanIntent): PaymentStateIntent {
  return {
    id: intent._id,
    userId: intent.userId,
    kind: intent.kind,
    providerMode: intent.providerMode,
    status: intent.status,
    planKey: intent.planKey,
    catalogVersion: intent.catalogVersion,
    listPricePaise: intent.quoteSnapshot.listPricePaise,
    discountPaise: intent.quoteSnapshot.discountPaise,
    payablePaise: intent.quoteSnapshot.payablePaise,
    renewalPricePaise: intent.quoteSnapshot.renewalPricePaise,
    couponCampaignId: intent.quoteSnapshot.couponCampaignId,
    currency: intent.quoteSnapshot.currency,
    razorpayOrderId: intent.razorpayOrderId,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    receipt: intent.receipt,
  }
}

function toSubscription(
  subscription: LeanSubscription,
): PaymentStateLocalSubscription {
  return {
    id: subscription._id,
    userId: subscription.userId,
    providerMode: subscription.providerMode,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    razorpayPlanId: subscription.razorpayPlanId,
    razorpaySubscriptionId:
      subscription.razorpaySubscriptionId,
    status: subscription.status,
    source: subscription.source,
  }
}

function toAttempt(attempt: LeanAttempt): StoredPaymentStateAttempt {
  return {
    id: attempt._id,
    providerMode: attempt.providerMode,
    checkoutIntentId: attempt.checkoutIntentId,
    razorpayPaymentId: attempt.razorpayPaymentId,
    razorpayOrderId: attempt.razorpayOrderId,
    razorpaySubscriptionId: attempt.razorpaySubscriptionId,
    razorpayInvoiceId: attempt.razorpayInvoiceId,
    userId: attempt.userId,
    status: attempt.status,
    amountPaise: attempt.amountPaise,
    currency: attempt.currency,
    providerSnapshot: attempt.providerSnapshot,
    lastSyncedAt: attempt.lastSyncedAt,
  }
}

function mongoTransaction(
  session: ClientSession,
  producer?: PaymentStateCommercialAnalyticsProducer,
): PaymentStatePersistenceTransaction {
  return {
    async loadIntent(intentId) {
      const intent = await CheckoutIntent.findById(intentId).select([
        '_id',
        'userId',
        'kind',
        'providerMode',
        'status',
        'planKey',
        'catalogVersion',
        'quoteSnapshot.listPricePaise',
        'quoteSnapshot.discountPaise',
        'quoteSnapshot.payablePaise',
        'quoteSnapshot.renewalPricePaise',
        'quoteSnapshot.couponCampaignId',
        'quoteSnapshot.currency',
        'razorpayOrderId',
        'razorpaySubscriptionId',
        'receipt',
      ].join(' ')).session(session).lean<LeanIntent>()
      return intent ? toIntent(intent) : null
    },

    async loadSubscription(input) {
      const subscription = await Subscription.findOne({
        providerMode: input.providerMode,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
      }).session(session).lean<LeanSubscription>()
      return subscription ? toSubscription(subscription) : null
    },

    async loadAttempt(input) {
      const attempt = await PaymentAttempt.findOne({
        providerMode: input.providerMode,
        razorpayPaymentId: input.razorpayPaymentId,
      }).session(session).lean<LeanAttempt>()
      return attempt ? toAttempt(attempt) : null
    },

    async createAttempt(draft) {
      const created = await PaymentAttempt.create([draft], { session })
      return created[0]._id
    },

    async transitionAttempt(input) {
      const update = await PaymentAttempt.updateOne(
        {
          _id: input.attempt.id,
          providerMode: input.attempt.providerMode,
          checkoutIntentId: input.attempt.checkoutIntentId,
          razorpayPaymentId: input.attempt.razorpayPaymentId,
          razorpayOrderId: input.attempt.razorpayOrderId,
          razorpaySubscriptionId:
            input.attempt.razorpaySubscriptionId,
          razorpayInvoiceId: input.attempt.razorpayInvoiceId,
          userId: input.attempt.userId,
          status: input.attempt.status,
          amountPaise: input.attempt.amountPaise,
          currency: input.attempt.currency,
        },
        {
          $set: {
            status: input.status,
            providerSnapshot: input.providerSnapshot,
            lastSyncedAt: input.lastSyncedAt,
          },
        },
        { session, runValidators: true },
      )
      return update.matchedCount === 1 && update.modifiedCount === 1
    },

    async appendPaymentStateCommercialAnalytics(
      requestedProducer,
      evidence,
    ) {
      if (!producer || requestedProducer !== producer) {
        throw failure(
          'persistence_conflict',
          'Payment state analytics producer is not transaction-bound',
        )
      }
      await producer.appendPaymentStateTransitionInSession(
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

export const mongoPaymentStatePersistenceStore:
PaymentStatePersistenceStore = {
  async runTransaction(work, producer) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await mongoose.startSession()
      let result: Awaited<ReturnType<typeof work>> | undefined
      let completed = false
      try {
        await session.withTransaction(async () => {
          result = await work(mongoTransaction(session, producer))
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
          'Payment state transaction returned no result',
        )
      }
      return result as Awaited<ReturnType<typeof work>>
    }
    throw failure(
      'persistence_conflict',
      'Payment attempt duplicate recovery was exhausted',
    )
  },
}

/**
 * Persists non-capture payment attempt state from a signature-verified
 * webhook and a server-fetched Razorpay entity. It never changes checkout,
 * subscription, fulfillment, or entitlement state. A failed payment id is
 * one failed attempt; a later, distinct payment id can still capture.
 */
export async function persistPaymentState(
  input: PaymentStateEffectInput,
  dependencies: PaymentStatePersistenceDependencies = {},
): Promise<PaymentStatePersistenceResult> {
  const observedAt = dependencies.now?.() ?? new Date()
  const validated = validateEffect(input, observedAt)
  const store =
    dependencies.store ?? mongoPaymentStatePersistenceStore
  try {
    return await store.runTransaction(
      (transaction) => persistInTransaction({
        validated,
        transaction,
        producer: dependencies.commercialAnalyticsProducer,
        observationSource: 'signed_webhook',
      }),
      dependencies.commercialAnalyticsProducer,
    )
  } catch (error) {
    if (error instanceof PaymentStatePersistenceError) throw error
    throw failure(
      'persistence_conflict',
      'Payment state could not be persisted durably',
      error,
    )
  }
}

/**
 * Clean server-observation input for reconciliation. Unlike a webhook effect,
 * it has no inbox identity or synthetic event type.
 */
export type PaymentProviderObservationInput = Omit<
  PaymentStateEffectInput,
  'inboxEventId' | 'eventType'
>

function validatePaymentProviderObservation(
  input: PaymentProviderObservationInput,
  observedAt: Date,
): ValidatedPaymentStateEffect {
  if (!validObservedAt(observedAt)) {
    throw failure('invalid_input', 'Payment observation time is invalid')
  }

  let payment: RazorpayPaymentDto
  try {
    payment = RazorpayPaymentDtoSchema.parse(input.payment)
  } catch (error) {
    throw failure(
      'invalid_input',
      'Server-fetched payment is not a normalized Razorpay payment',
      error,
    )
  }
  if (
    payment.providerMode !== input.providerMode ||
    payment.id !== input.razorpayPaymentId ||
    !sameOptional(payment.orderId, input.razorpayOrderId) ||
    !sameOptional(
      payment.subscriptionId,
      input.razorpaySubscriptionId,
    ) ||
    !sameOptional(payment.invoiceId, input.razorpayInvoiceId)
  ) {
    throw failure(
      'reference_conflict',
      'Server-fetched payment does not match the provider observation',
    )
  }
  if (
    (payment.status !== 'authorized' && payment.status !== 'failed') ||
    payment.captured !== false ||
    payment.amountRefundedPaise !== 0 ||
    payment.amountPaise <= 0
  ) {
    throw failure(
      'payment_state_conflict',
      'Provider observation lacks an unreversed authorized or failed attempt',
    )
  }

  const normalizedPayment = payment as RazorpayPaymentDto & {
    status: 'authorized' | 'failed'
    captured: false
    amountRefundedPaise: 0
  }
  const binding = normalizedPayment.subscriptionId
    ? subscriptionBinding({
        effect: input,
        payment: normalizedPayment,
      })
    : oneTimeBinding({
        effect: input,
        payment: normalizedPayment,
      })

  return {
    binding,
    failureReason: analyticsFailureReason(normalizedPayment),
    draft: {
      providerMode: input.providerMode,
      checkoutIntentId: binding.intent.id,
      razorpayPaymentId: normalizedPayment.id,
      ...(normalizedPayment.orderId
        ? { razorpayOrderId: normalizedPayment.orderId }
        : {}),
      ...(normalizedPayment.subscriptionId
        ? {
            razorpaySubscriptionId:
              normalizedPayment.subscriptionId,
          }
        : {}),
      ...(normalizedPayment.invoiceId
        ? { razorpayInvoiceId: normalizedPayment.invoiceId }
        : {}),
      userId: binding.intent.userId,
      status: normalizedPayment.status,
      amountPaise: normalizedPayment.amountPaise,
      currency: 'INR',
      providerSnapshot: normalizedSnapshot(normalizedPayment),
      lastSyncedAt: observedAt,
    },
  }
}

/**
 * Persists an authorized or failed payment found by an exact provider read.
 * It shares the webhook transaction and idempotency model without inventing a
 * webhook event, inbox row, or inbox identifier.
 */
export async function persistPaymentProviderObservation(
  input: PaymentProviderObservationInput,
  dependencies: PaymentStatePersistenceDependencies = {},
): Promise<PaymentStatePersistenceResult> {
  const observedAt = dependencies.now?.() ?? new Date()
  const validated = validatePaymentProviderObservation(
    input,
    observedAt,
  )
  const store =
    dependencies.store ?? mongoPaymentStatePersistenceStore
  try {
    return await store.runTransaction(
      (transaction) => persistInTransaction({
        validated,
        transaction,
        producer: dependencies.commercialAnalyticsProducer,
        observationSource: 'provider_fetch',
      }),
      dependencies.commercialAnalyticsProducer,
    )
  } catch (error) {
    if (error instanceof PaymentStatePersistenceError) throw error
    throw failure(
      'persistence_conflict',
      'Payment observation could not be persisted durably',
      error,
    )
  }
}
