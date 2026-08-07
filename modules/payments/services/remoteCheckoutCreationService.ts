import { randomUUID } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import {
  ConsumerSubscriptionLease,
  type ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import {
  CheckoutIntent,
  type CheckoutIntentKind,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import {
  createRazorpayClientFactory,
  type RazorpayClientFactory,
} from '../providers/razorpayClientFactory'
import {
  RazorpayReconciliationConflictError,
  RazorpayRecoveryScanLimitError,
  type RazorpayOrderDto,
  type RazorpayServerAdapter,
  type RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import { getBillingConfig } from './billingConfigService'
import {
  CURRENT_PAYMENT_CODE_READINESS,
  evaluatePaymentSaleGate,
  type PaymentSaleBlockReason,
  type PaymentSaleGate,
} from './paymentRuntimeGate'
import {
  CheckoutBlockedByAccountDeletionError,
  ConsumerBillingFenceConflictError,
  claimConsumerBillingFenceForCheckout,
  mongoConsumerBillingFenceMutationStore,
} from './consumerBillingFenceService'

export const REMOTE_CHECKOUT_CREATION_ERROR_CODES = [
  'invalid_request',
  'sale_blocked',
  'intent_not_found',
  'intent_state_invalid',
  'intent_mode_mismatch',
  'intent_shape_invalid',
  'subscription_spec_unavailable',
  'provider_unavailable',
  'remote_mismatch',
  'reconciliation_conflict',
  'persistence_conflict',
] as const
export type RemoteCheckoutCreationErrorCode =
  (typeof REMOTE_CHECKOUT_CREATION_ERROR_CODES)[number]

export class RemoteCheckoutCreationError extends Error {
  readonly code: RemoteCheckoutCreationErrorCode
  readonly saleBlockReason?: PaymentSaleBlockReason

  constructor(
    code: RemoteCheckoutCreationErrorCode,
    message: string,
    options?: ErrorOptions & {
      saleBlockReason?: PaymentSaleBlockReason
    },
  ) {
    super(message, options)
    this.name = 'RemoteCheckoutCreationError'
    this.code = code
    this.saleBlockReason = options?.saleBlockReason
  }
}

export interface RemoteCheckoutCreationInput {
  userId: string
  intentId: string
}

export interface TrustedRemoteCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  receipt: string
  payablePaise: number
  discountPaise: number
  currency: 'INR'
  discountedBillingCycles?: number
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  createdAt: Date
}

export interface TrustedSubscriptionCheckoutSpec {
  planKey: 'plus' | 'pro'
  razorpayPlanId: string
  upfrontAmountPaise?: number
  upfrontItemName?: string
  totalCount: number
  purpose: CheckoutIntentPurpose
  planChangeRequestId?: string
  leaseLane: ConsumerSubscriptionLeaseLane
  startAtEpochSeconds?: number
  authorizationExpiresAtEpochSeconds: number
}

export interface RemoteCheckoutAttachInput {
  intent: TrustedRemoteCheckoutIntent
  remoteId: string
  claimToken: string
}

export type RemoteCheckoutAttachResult =
  | {
      outcome: 'attached' | 'reused'
      remoteId: string
    }
  | {
      outcome: 'conflict'
    }

export type RemoteCheckoutCreationClaimResult =
  | {
      outcome: 'claimed'
      intent: TrustedRemoteCheckoutIntent
      recoveryOnly: boolean
    }
  | {
      outcome: 'busy' | 'conflict'
    }

export interface RemoteCheckoutCreationStore {
  /**
   * Production stores must load the intent and claim its active consumer
   * billing fence in one durable transaction before returning it.
   */
  loadIntentForUser(input: {
    intentId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<TrustedRemoteCheckoutIntent | null>
  claimRemoteCreation(input: {
    intent: TrustedRemoteCheckoutIntent
    claimToken: string
    claimedAt: Date
    leaseExpiresAt: Date
  }): Promise<RemoteCheckoutCreationClaimResult>
  markRemoteCreationStarted(input: {
    intent: TrustedRemoteCheckoutIntent
    claimToken: string
    startedAt: Date
    leaseExpiresAt: Date
  }): Promise<boolean>
  releaseRemoteCreationClaim(input: {
    intent: TrustedRemoteCheckoutIntent
    claimToken: string
  }): Promise<void>
  attachRemoteId(
    input: RemoteCheckoutAttachInput,
  ): Promise<RemoteCheckoutAttachResult>
  markReview(input: {
    intent: TrustedRemoteCheckoutIntent
    claimToken: string
  }): Promise<boolean>
}

export interface RemoteCheckoutCreationDependencies {
  store?: RemoteCheckoutCreationStore
  clientFactory?: RazorpayClientFactory
  evaluateSaleGate?: (
    userId: string,
  ) => PaymentSaleGate | Promise<PaymentSaleGate>
  resolveSubscriptionSpec?: (
    intent: TrustedRemoteCheckoutIntent,
  ) => (
    TrustedSubscriptionCheckoutSpec |
    Promise<TrustedSubscriptionCheckoutSpec>
  )
  now?: () => Date
}

export type RemoteCheckoutCreationSource =
  | 'existing'
  | 'pre_create_recovery'
  | 'created'
  | 'post_failure_recovery'

export interface RemoteCheckoutCreationResult {
  intentId: string
  providerMode: ProviderMode
  kind: CheckoutIntentKind
  remoteId: string
  source: RemoteCheckoutCreationSource
  reused: boolean
}

const REMOTE_CREATABLE_INTENT_STATUSES:
readonly CheckoutIntentStatus[] = [
  'created',
  'remote_created',
]
const RECOVERY_WINDOW_SECONDS = 72 * 60 * 60
const RECOVERY_CLOCK_SKEW_SECONDS = 5 * 60
const REMOTE_CREATION_LEASE_MS = 2 * 60 * 1_000
const defaultClientFactory = createRazorpayClientFactory()

interface AcquiredRemoteCreationLease {
  claimToken: string
  recoveryOnly: boolean
  providerCreationAttempted: boolean
}

function failure(
  code: RemoteCheckoutCreationErrorCode,
  message: string,
  cause?: unknown,
): RemoteCheckoutCreationError {
  return new RemoteCheckoutCreationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function parseObjectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) {
    throw failure('invalid_request', `${label} must be a MongoDB ObjectId`)
  }
  return new mongoose.Types.ObjectId(value)
}

async function defaultEvaluateSaleGate(
  userId: string,
): Promise<PaymentSaleGate> {
  if (!CURRENT_PAYMENT_CODE_READINESS.remoteCreationReady) {
    return { allowed: false, reason: 'remote_creation_not_ready' }
  }
  const config = await getBillingConfig()
  const configGate = evaluatePaymentSaleGate(
    config,
    userId,
    CURRENT_PAYMENT_CODE_READINESS,
  )
  if (!configGate.allowed) return configGate

  await connectDB()
  const buyer = await User.findById(userId)
    .select('buyerState')
    .lean<{ buyerState?: string }>()
  if (!buyer) {
    return { allowed: false, reason: 'buyer_not_found' }
  }
  return evaluatePaymentSaleGate(
    config,
    userId,
    CURRENT_PAYMENT_CODE_READINESS,
    buyer.buyerState,
  )
}

function exactEpochSecondDate(value: unknown): value is Date {
  return (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getMilliseconds() === 0
  )
}

function assertIntentShape(intent: TrustedRemoteCheckoutIntent): void {
  if (!REMOTE_CREATABLE_INTENT_STATUSES.includes(intent.status)) {
    throw failure(
      'intent_state_invalid',
      'Checkout intent is not eligible for remote creation or reuse',
    )
  }
  if (
    !Number.isSafeInteger(intent.payablePaise) ||
    intent.payablePaise <= 0 ||
    !Number.isSafeInteger(intent.discountPaise) ||
    intent.discountPaise < 0 ||
    intent.currency !== 'INR' ||
    !intent.receipt ||
    intent.receipt.length > 40 ||
    Number.isNaN(intent.createdAt.getTime())
  ) {
    throw failure(
      'intent_shape_invalid',
      'Checkout intent commercial snapshot is invalid',
    )
  }
  if (intent.kind === 'subscription') {
    if (
      (intent.planKey !== 'plus' && intent.planKey !== 'pro') ||
      intent.razorpayOrderId !== undefined ||
      !intent.purpose ||
      !intent.leaseLane ||
      !exactEpochSecondDate(intent.authorizationExpiresAt) ||
      intent.authorizationExpiresAt <= intent.createdAt
    ) {
      throw failure(
        'intent_shape_invalid',
        'Subscription intent has inconsistent trusted fields',
      )
    }
    if (intent.purpose === 'acquisition') {
      const couponUpfrontLifecycle =
        intent.discountPaise > 0 &&
        intent.discountedBillingCycles === 1 &&
        exactEpochSecondDate(intent.requestedStartAt) &&
        intent.authorizationExpiresAt < intent.requestedStartAt
      if (
        intent.leaseLane !== 'a' ||
        intent.planChangeRequestId !== undefined ||
        (
          intent.requestedStartAt !== undefined &&
          !couponUpfrontLifecycle
        )
      ) {
        throw failure(
          'intent_shape_invalid',
          'Acquisition intent has inconsistent trusted lifecycle fields',
        )
      }
    } else if (
      !intent.planChangeRequestId ||
      !mongoose.isValidObjectId(intent.planChangeRequestId) ||
      !exactEpochSecondDate(intent.requestedStartAt) ||
      intent.authorizationExpiresAt >= intent.requestedStartAt
    ) {
      throw failure(
        'intent_shape_invalid',
        'Future subscription intent lacks exact lifecycle evidence',
      )
    }
  } else if (
    intent.planKey !== undefined ||
    intent.razorpaySubscriptionId !== undefined ||
    intent.purpose !== undefined ||
    intent.planChangeRequestId !== undefined ||
    intent.leaseLane !== undefined ||
    intent.requestedStartAt !== undefined ||
    intent.authorizationExpiresAt !== undefined
  ) {
    throw failure(
      'intent_shape_invalid',
      'One-time intent has inconsistent trusted fields',
    )
  }
}

function assertSubscriptionSpec(
  intent: TrustedRemoteCheckoutIntent,
  spec: TrustedSubscriptionCheckoutSpec,
): void {
  const expectedPlanChangeRequestId =
    intent.planChangeRequestId?.toString()
  const expectedStartAtEpochSeconds = intent.requestedStartAt
    ? Math.floor(intent.requestedStartAt.getTime() / 1_000)
    : undefined
  const expectedAuthorizationExpiresAtEpochSeconds =
    intent.authorizationExpiresAt
      ? Math.floor(intent.authorizationExpiresAt.getTime() / 1_000)
      : undefined
  if (
    spec.planKey !== intent.planKey ||
    !/^plan_[A-Za-z0-9]+$/.test(spec.razorpayPlanId) ||
    !Number.isSafeInteger(spec.totalCount) ||
    spec.totalCount <= 0 ||
    spec.purpose !== intent.purpose ||
    spec.planChangeRequestId !== expectedPlanChangeRequestId ||
    spec.leaseLane !== intent.leaseLane ||
    spec.startAtEpochSeconds !== expectedStartAtEpochSeconds ||
    !Number.isSafeInteger(
      spec.authorizationExpiresAtEpochSeconds,
    ) ||
    spec.authorizationExpiresAtEpochSeconds <= 0 ||
    spec.authorizationExpiresAtEpochSeconds !==
      expectedAuthorizationExpiresAtEpochSeconds
  ) {
    throw failure(
      'subscription_spec_unavailable',
      'Trusted subscription provider specification is invalid',
    )
  }
  const discounted = intent.discountPaise > 0
  const hasUpfrontAmount = spec.upfrontAmountPaise !== undefined
  if (
    discounted !== hasUpfrontAmount ||
    (
      discounted &&
      (
        intent.purpose !== 'acquisition' ||
        intent.discountedBillingCycles !== 1 ||
        spec.startAtEpochSeconds === undefined ||
        spec.upfrontAmountPaise !== intent.payablePaise ||
        typeof spec.upfrontItemName !== 'string' ||
        spec.upfrontItemName.trim().length < 1 ||
        spec.upfrontItemName.length > 100
      )
    ) ||
    (!discounted && spec.upfrontItemName !== undefined)
  ) {
    throw failure(
      'subscription_spec_unavailable',
      'Trusted subscription upfront amount does not match the checkout quote',
    )
  }
  if (
    intent.discountedBillingCycles !== undefined &&
    (
      !Number.isSafeInteger(intent.discountedBillingCycles) ||
      intent.discountedBillingCycles <= 0 ||
      intent.discountedBillingCycles > spec.totalCount
    )
  ) {
    throw failure(
      'subscription_spec_unavailable',
      'Discounted cycle promise exceeds the trusted subscription term',
    )
  }
}

function assertAdapterMode(
  adapter: RazorpayServerAdapter,
  mode: ProviderMode,
): void {
  if (adapter.providerMode !== mode) {
    throw failure(
      'intent_mode_mismatch',
      'Razorpay client mode does not match the checkout intent',
    )
  }
}

function assertOrderMatches(
  intent: TrustedRemoteCheckoutIntent,
  order: RazorpayOrderDto,
  expectedRemoteId?: string,
): void {
  if (
    order.providerMode !== intent.providerMode ||
    (expectedRemoteId !== undefined && order.id !== expectedRemoteId) ||
    order.amountPaise !== intent.payablePaise ||
    order.currency !== intent.currency ||
    order.receipt !== intent.receipt
  ) {
    throw failure(
      'remote_mismatch',
      'Razorpay Order does not match the trusted checkout intent',
    )
  }
}

function assertSubscriptionMatches(
  intent: TrustedRemoteCheckoutIntent,
  spec: TrustedSubscriptionCheckoutSpec,
  subscription: RazorpaySubscriptionDto,
  expectedRemoteId?: string,
): void {
  if (
    subscription.providerMode !== intent.providerMode ||
    (
      expectedRemoteId !== undefined &&
      subscription.id !== expectedRemoteId
    ) ||
    subscription.planId !== spec.razorpayPlanId ||
    subscription.offerId !== undefined ||
    subscription.totalCount !== spec.totalCount ||
    subscription.authorizationExpiresAtEpochSeconds !==
      spec.authorizationExpiresAtEpochSeconds ||
    (
      spec.startAtEpochSeconds !== undefined &&
      subscription.startAtEpochSeconds !== spec.startAtEpochSeconds
    ) ||
    subscription.notes.checkout_receipt !== intent.receipt ||
    subscription.notes.checkout_intent_id !== intent._id.toString() ||
    subscription.notes.catalog_version !== intent.catalogVersion ||
    subscription.notes.checkout_purpose !== intent.purpose ||
    subscription.notes.subscription_lease_lane !== intent.leaseLane ||
    subscription.notes.coupon_upfront_amount_paise?.toString() !==
      spec.upfrontAmountPaise?.toString() ||
    subscription.notes.coupon_discounted_billing_cycles?.toString() !==
      intent.discountedBillingCycles?.toString() ||
    subscription.notes.plan_change_request_id !==
      intent.planChangeRequestId?.toString()
  ) {
    throw failure(
      'remote_mismatch',
      'Razorpay Subscription does not match the trusted checkout intent',
    )
  }
}

function subscriptionRecoveryWindow(
  intent: TrustedRemoteCheckoutIntent,
  now: Date,
): { fromEpochSeconds: number; toEpochSeconds: number } {
  if (Number.isNaN(now.getTime())) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  const toEpochSeconds =
    Math.floor(now.getTime() / 1000) + RECOVERY_CLOCK_SKEW_SECONDS
  const earliestBounded =
    toEpochSeconds - RECOVERY_WINDOW_SECONDS
  const intentStart =
    Math.floor(intent.createdAt.getTime() / 1000) -
    RECOVERY_CLOCK_SKEW_SECONDS
  return {
    fromEpochSeconds: Math.max(0, earliestBounded, intentStart),
    toEpochSeconds,
  }
}

async function reviewAndThrow(
  store: RemoteCheckoutCreationStore,
  intent: TrustedRemoteCheckoutIntent,
  lease: AcquiredRemoteCreationLease,
  error: RemoteCheckoutCreationError,
): Promise<never> {
  try {
    const persisted = await store.markReview({
      intent,
      claimToken: lease.claimToken,
    })
    if (!persisted) {
      throw new Error('Remote creation claim no longer owns the intent')
    }
  } catch (reviewError) {
    throw failure(
      'persistence_conflict',
      'Checkout requires review but review state could not be persisted',
      reviewError,
    )
  }
  throw error
}

function recoveryConflict(error: unknown): boolean {
  return (
    error instanceof RazorpayReconciliationConflictError ||
    error instanceof RazorpayRecoveryScanLimitError
  )
}

async function resolveTrustedSubscriptionSpec(
  intent: TrustedRemoteCheckoutIntent,
  resolver:
    | RemoteCheckoutCreationDependencies['resolveSubscriptionSpec']
    | undefined,
): Promise<TrustedSubscriptionCheckoutSpec> {
  if (!resolver) {
    throw failure(
      'subscription_spec_unavailable',
      'Trusted subscription provider specification is unavailable',
    )
  }
  let spec: TrustedSubscriptionCheckoutSpec
  try {
    spec = await resolver(intent)
  } catch (error) {
    if (error instanceof RemoteCheckoutCreationError) throw error
    throw failure(
      'subscription_spec_unavailable',
      'Trusted subscription provider specification is unavailable',
      error,
    )
  }
  assertSubscriptionSpec(intent, spec)
  return spec
}

async function recoverOrder(
  adapter: RazorpayServerAdapter,
  intent: TrustedRemoteCheckoutIntent,
): Promise<RazorpayOrderDto | null> {
  return adapter.findOrderByReceipt(intent.receipt)
}

async function recoverSubscription(
  adapter: RazorpayServerAdapter,
  intent: TrustedRemoteCheckoutIntent,
  spec: TrustedSubscriptionCheckoutSpec,
  now: Date,
): Promise<RazorpaySubscriptionDto | null> {
  const window = subscriptionRecoveryWindow(intent, now)
  return adapter.findSubscriptionByCheckoutReceipt({
    checkoutReceipt: intent.receipt,
    expectedPlanId: spec.razorpayPlanId,
    ...window,
  })
}

async function markProviderCreationStarted(input: {
  store: RemoteCheckoutCreationStore
  intent: TrustedRemoteCheckoutIntent
  lease: AcquiredRemoteCreationLease
  now: () => Date
}): Promise<void> {
  if (input.lease.recoveryOnly) {
    throw failure(
      'persistence_conflict',
      'A recovered remote creation claim cannot create another provider object',
    )
  }
  const startedAt = input.now()
  if (Number.isNaN(startedAt.getTime())) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  let started: boolean
  try {
    started = await input.store.markRemoteCreationStarted({
      intent: input.intent,
      claimToken: input.lease.claimToken,
      startedAt,
      leaseExpiresAt: new Date(
        startedAt.getTime() + REMOTE_CREATION_LEASE_MS,
      ),
    })
  } catch (error) {
    throw failure(
      'persistence_conflict',
      'Remote creation start could not be persisted',
      error,
    )
  }
  if (!started) {
    throw failure(
      'persistence_conflict',
      'Remote creation claim expired before provider creation',
    )
  }
  input.lease.providerCreationAttempted = true
}

async function attachResult(input: {
  store: RemoteCheckoutCreationStore
  intent: TrustedRemoteCheckoutIntent
  lease: AcquiredRemoteCreationLease
  remoteId: string
  source: RemoteCheckoutCreationSource
}): Promise<RemoteCheckoutCreationResult> {
  let attached: RemoteCheckoutAttachResult
  try {
    attached = await input.store.attachRemoteId({
      intent: input.intent,
      remoteId: input.remoteId,
      claimToken: input.lease.claimToken,
    })
  } catch (error) {
    if (error instanceof RemoteCheckoutCreationError) throw error
    throw failure(
      'persistence_conflict',
      'Remote checkout identifier could not be persisted',
      error,
    )
  }
  if (attached.outcome === 'conflict') {
    return reviewAndThrow(
      input.store,
      input.intent,
      input.lease,
      failure(
        'persistence_conflict',
        'A different remote checkout identifier won the attach race',
      ),
    )
  }
  if (attached.remoteId !== input.remoteId) {
    return reviewAndThrow(
      input.store,
      input.intent,
      input.lease,
      failure(
        'persistence_conflict',
        'Persisted remote checkout identifier is inconsistent',
      ),
    )
  }
  return {
    intentId: input.intent._id.toString(),
    providerMode: input.intent.providerMode,
    kind: input.intent.kind,
    remoteId: input.remoteId,
    source: input.source,
    reused:
      attached.outcome === 'reused' ||
      input.source !== 'created',
  }
}

async function createOrRecoverOrder(input: {
  adapter: RazorpayServerAdapter
  store: RemoteCheckoutCreationStore
  intent: TrustedRemoteCheckoutIntent
  lease: AcquiredRemoteCreationLease
  now: () => Date
}): Promise<RemoteCheckoutCreationResult> {
  const { adapter, store, intent, lease, now } = input
  if (intent.razorpayOrderId) {
    let existing: RazorpayOrderDto
    try {
      existing = await adapter.fetchOrder(intent.razorpayOrderId)
    } catch (error) {
      throw failure(
        'provider_unavailable',
        'Existing Razorpay Order could not be verified',
        error,
      )
    }
    try {
      assertOrderMatches(intent, existing, intent.razorpayOrderId)
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: existing.id,
      source: 'existing',
    })
  }

  let recovered: RazorpayOrderDto | null
  try {
    recovered = await recoverOrder(adapter, intent)
  } catch (error) {
    if (recoveryConflict(error)) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          'reconciliation_conflict',
          'Razorpay Order recovery is ambiguous',
          error,
        ),
      )
    }
    throw failure(
      'provider_unavailable',
      'Razorpay Order recovery is unavailable',
      error,
    )
  }
  if (recovered) {
    try {
      assertOrderMatches(intent, recovered)
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: recovered.id,
      source: 'pre_create_recovery',
    })
  }

  if (lease.recoveryOnly) {
    return reviewAndThrow(
      store,
      intent,
      lease,
      failure(
        'reconciliation_conflict',
        'Previous Razorpay Order creation could not be reconciled',
      ),
    )
  }

  await markProviderCreationStarted({ store, intent, lease, now })

  let created: RazorpayOrderDto
  try {
    created = await adapter.createOrder({
      amountPaise: intent.payablePaise,
      currency: 'INR',
      receipt: intent.receipt,
      notes: {
        checkout_intent_id: intent._id.toString(),
        catalog_version: intent.catalogVersion,
      },
    })
  } catch (createError) {
    try {
      recovered = await recoverOrder(adapter, intent)
    } catch (recoveryError) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          recoveryConflict(recoveryError)
            ? 'reconciliation_conflict'
            : 'provider_unavailable',
          'Razorpay Order create outcome requires review',
          recoveryError,
        ),
      )
    }
    if (!recovered) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          'provider_unavailable',
          'Razorpay Order creation could not be confirmed',
          createError,
        ),
      )
    }
    try {
      assertOrderMatches(intent, recovered)
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: recovered.id,
      source: 'post_failure_recovery',
    })
  }

  try {
    assertOrderMatches(intent, created)
  } catch (error) {
    return reviewAndThrow(
      store,
      intent,
      lease,
      error as RemoteCheckoutCreationError,
    )
  }
  return attachResult({
    store,
    intent,
    lease,
    remoteId: created.id,
    source: 'created',
  })
}

async function createOrRecoverSubscription(input: {
  adapter: RazorpayServerAdapter
  store: RemoteCheckoutCreationStore
  intent: TrustedRemoteCheckoutIntent
  lease: AcquiredRemoteCreationLease
  spec: TrustedSubscriptionCheckoutSpec
  recoveryNow: Date
  now: () => Date
}): Promise<RemoteCheckoutCreationResult> {
  const { adapter, store, intent, lease, spec, recoveryNow, now } = input
  if (intent.razorpaySubscriptionId) {
    let existing: RazorpaySubscriptionDto
    try {
      existing = await adapter.fetchSubscription(
        intent.razorpaySubscriptionId,
      )
    } catch (error) {
      throw failure(
        'provider_unavailable',
        'Existing Razorpay Subscription could not be verified',
        error,
      )
    }
    try {
      assertSubscriptionMatches(
        intent,
        spec,
        existing,
        intent.razorpaySubscriptionId,
      )
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: existing.id,
      source: 'existing',
    })
  }

  let recovered: RazorpaySubscriptionDto | null
  try {
    recovered = await recoverSubscription(
      adapter,
      intent,
      spec,
      recoveryNow,
    )
  } catch (error) {
    if (recoveryConflict(error)) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          'reconciliation_conflict',
          'Razorpay Subscription recovery is ambiguous',
          error,
        ),
      )
    }
    throw failure(
      'provider_unavailable',
      'Razorpay Subscription recovery is unavailable',
      error,
    )
  }
  if (recovered) {
    try {
      assertSubscriptionMatches(intent, spec, recovered)
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: recovered.id,
      source: 'pre_create_recovery',
    })
  }
  if (lease.recoveryOnly) {
    return reviewAndThrow(
      store,
      intent,
      lease,
      failure(
        'reconciliation_conflict',
        'Previous Razorpay Subscription creation could not be reconciled',
      ),
    )
  }
  const createAt = now()
  if (Number.isNaN(createAt.getTime())) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  if (
    createAt.getTime() >=
      spec.authorizationExpiresAtEpochSeconds * 1_000
  ) {
    throw failure(
      'intent_state_invalid',
      'Subscription authorization window expired before provider creation',
    )
  }

  await markProviderCreationStarted({ store, intent, lease, now })

  let created: RazorpaySubscriptionDto
  try {
    created = await adapter.createSubscription({
      planId: spec.razorpayPlanId,
      totalCount: spec.totalCount,
      ...(spec.upfrontAmountPaise !== undefined
        ? {
            upfrontItem: {
              name: spec.upfrontItemName as string,
              amountPaise: spec.upfrontAmountPaise,
              currency: 'INR' as const,
            },
          }
        : {}),
      ...(spec.startAtEpochSeconds !== undefined
        ? { startAtEpochSeconds: spec.startAtEpochSeconds }
        : {}),
      authorizationExpiresAtEpochSeconds:
        spec.authorizationExpiresAtEpochSeconds,
      customerNotify: false,
      receipt: intent.receipt,
      notes: {
        checkout_intent_id: intent._id.toString(),
        catalog_version: intent.catalogVersion,
        checkout_purpose: spec.purpose,
        subscription_lease_lane: spec.leaseLane,
        ...(spec.upfrontAmountPaise !== undefined
          ? {
              coupon_upfront_amount_paise:
                spec.upfrontAmountPaise,
              coupon_discounted_billing_cycles:
                intent.discountedBillingCycles as number,
            }
          : {}),
        ...(spec.planChangeRequestId
          ? {
              plan_change_request_id:
                spec.planChangeRequestId,
            }
          : {}),
      },
    })
  } catch (createError) {
    try {
      recovered = await recoverSubscription(
        adapter,
        intent,
        spec,
        now(),
      )
    } catch (recoveryError) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          recoveryConflict(recoveryError)
            ? 'reconciliation_conflict'
            : 'provider_unavailable',
          'Razorpay Subscription create outcome requires review',
          recoveryError,
        ),
      )
    }
    if (!recovered) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        failure(
          'provider_unavailable',
          'Razorpay Subscription creation could not be confirmed',
          createError,
        ),
      )
    }
    try {
      assertSubscriptionMatches(intent, spec, recovered)
    } catch (error) {
      return reviewAndThrow(
        store,
        intent,
        lease,
        error as RemoteCheckoutCreationError,
      )
    }
    return attachResult({
      store,
      intent,
      lease,
      remoteId: recovered.id,
      source: 'post_failure_recovery',
    })
  }

  try {
    assertSubscriptionMatches(intent, spec, created)
  } catch (error) {
    return reviewAndThrow(
      store,
      intent,
      lease,
      error as RemoteCheckoutCreationError,
    )
  }
  return attachResult({
    store,
    intent,
    lease,
    remoteId: created.id,
    source: 'created',
  })
}

interface LeanRemoteCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  catalogVersion: string
  receipt: string
  quoteSnapshot: {
    payablePaise: number
    discountPaise: number
    currency: 'INR'
    discountedBillingCycles?: number
  }
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  remoteCreationStartedAt?: Date
  createdAt: Date
}

interface LeanSubscriptionLease {
  _id: mongoose.Types.ObjectId
  lane: ConsumerSubscriptionLeaseLane
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId?: string
  status: 'held' | 'release_pending' | 'released' | 'review'
}

function toTrustedIntent(
  intent: LeanRemoteCheckoutIntent,
): TrustedRemoteCheckoutIntent {
  return {
    _id: intent._id,
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
    receipt: intent.receipt,
    payablePaise: intent.quoteSnapshot.payablePaise,
    discountPaise: intent.quoteSnapshot.discountPaise,
    currency: intent.quoteSnapshot.currency,
    discountedBillingCycles:
      intent.quoteSnapshot.discountedBillingCycles,
    razorpayOrderId: intent.razorpayOrderId,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    createdAt: intent.createdAt,
  }
}

async function loadMongoIntent(
  intentId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<TrustedRemoteCheckoutIntent | null> {
  const query = CheckoutIntent.findOne({
    _id: intentId,
    userId,
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
    receipt: 1,
    quoteSnapshot: 1,
    razorpayOrderId: 1,
    razorpaySubscriptionId: 1,
    createdAt: 1,
  })
  if (session) query.session(session)
  const intent = await query.lean<LeanRemoteCheckoutIntent>()
  return intent ? toTrustedIntent(intent) : null
}

function sameCommercialIntent(
  current: TrustedRemoteCheckoutIntent,
  expected: TrustedRemoteCheckoutIntent,
): boolean {
  return (
    current.kind === expected.kind &&
    current.providerMode === expected.providerMode &&
    current.purpose === expected.purpose &&
    current.planChangeRequestId?.toString() ===
      expected.planChangeRequestId?.toString() &&
    current.leaseLane === expected.leaseLane &&
    current.requestedStartAt?.getTime() ===
      expected.requestedStartAt?.getTime() &&
    current.authorizationExpiresAt?.getTime() ===
      expected.authorizationExpiresAt?.getTime() &&
    current.planKey === expected.planKey &&
    current.catalogVersion === expected.catalogVersion &&
    current.receipt === expected.receipt &&
    current.payablePaise === expected.payablePaise &&
    current.discountPaise === expected.discountPaise &&
    current.currency === expected.currency &&
    current.discountedBillingCycles === expected.discountedBillingCycles &&
    (
      current.kind === 'subscription'
        ? current.razorpayOrderId === undefined
        : current.razorpaySubscriptionId === undefined
    )
  )
}

async function markReviewInSession(
  intent: TrustedRemoteCheckoutIntent,
  claimToken: string,
  session: ClientSession,
): Promise<boolean> {
  const intentReview = await CheckoutIntent.updateOne(
    {
      _id: intent._id,
      userId: intent.userId,
      providerMode: intent.providerMode,
      status: { $in: REMOTE_CREATABLE_INTENT_STATUSES },
      remoteCreationLeaseToken: claimToken,
    },
    {
      $set: { status: 'review' },
      $unset: {
        nextRecoveryAt: 1,
        remoteCreationLeaseToken: 1,
        remoteCreationLeaseExpiresAt: 1,
        remoteCreationStartedAt: 1,
      },
    },
    { session, runValidators: true },
  )
  if (
    intent.kind === 'subscription' &&
    intentReview.matchedCount === 1 &&
    intent.leaseLane
  ) {
    await ConsumerSubscriptionLease.updateOne(
      {
        userId: intent.userId,
        providerMode: intent.providerMode,
        ownerCheckoutIntentId: intent._id,
        lane: intent.leaseLane,
        status: { $ne: 'released' },
      },
      { $set: { status: 'review' } },
      { session, runValidators: true },
    )
  }
  if (intentReview.matchedCount === 1) return true

  const alreadyReviewed = await CheckoutIntent.exists({
    _id: intent._id,
    userId: intent.userId,
    providerMode: intent.providerMode,
    status: 'review',
  }).session(session)
  return alreadyReviewed !== null
}

async function markMongoIntentReview(
  intent: TrustedRemoteCheckoutIntent,
  claimToken: string,
): Promise<boolean> {
  await connectDB()
  const session = await mongoose.startSession()
  let marked = false
  try {
    await session.withTransaction(async () => {
      marked = await markReviewInSession(intent, claimToken, session)
    }, {
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  return marked
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11000,
  )
}

function transientTransactionError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('hasErrorLabel' in error) ||
    typeof error.hasErrorLabel !== 'function'
  ) {
    return false
  }
  return error.hasErrorLabel('TransientTransactionError')
}

export const mongoRemoteCheckoutCreationStore:
RemoteCheckoutCreationStore = {
  async loadIntentForUser(input) {
    await connectDB()
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await mongoose.startSession()
      let intent: TrustedRemoteCheckoutIntent | null | undefined
      try {
        await session.withTransaction(async () => {
          intent = await loadMongoIntent(
            input.intentId,
            input.userId,
            session,
          )
          if (!intent) return
          await claimConsumerBillingFenceForCheckout(
            {
              userId: intent.userId,
              checkoutIntentId: intent._id,
              kind: intent.kind,
              providerMode: intent.providerMode,
              claimedAt: new Date(),
            },
            mongoConsumerBillingFenceMutationStore(session),
          )
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        })
        return intent ?? null
      } catch (error) {
        if (
          error instanceof CheckoutBlockedByAccountDeletionError
        ) {
          throw error
        }
        lastError = error
        const retryable =
          isMongoDuplicateKeyError(error) ||
          transientTransactionError(error) ||
          error instanceof ConsumerBillingFenceConflictError
        if (retryable && attempt < 2) continue
        break
      } finally {
        await session.endSession()
      }
    }
    if (lastError instanceof ConsumerBillingFenceConflictError) {
      throw lastError
    }
    throw new ConsumerBillingFenceConflictError()
  },

  async claimRemoteCreation(input) {
    await connectDB()
    const current = await CheckoutIntent.findOneAndUpdate(
      {
        _id: input.intent._id,
        userId: input.intent.userId,
        providerMode: input.intent.providerMode,
        status: { $in: REMOTE_CREATABLE_INTENT_STATUSES },
        $or: [
          { remoteCreationLeaseToken: { $exists: false } },
          {
            remoteCreationLeaseExpiresAt: {
              $lte: input.claimedAt,
            },
          },
        ],
      },
      {
        $set: {
          remoteCreationLeaseToken: input.claimToken,
          remoteCreationLeaseExpiresAt: input.leaseExpiresAt,
        },
      },
      {
        new: false,
        runValidators: true,
        writeConcern: { w: 'majority' },
      },
    ).lean<LeanRemoteCheckoutIntent>()

    if (!current) {
      const leaseState = await CheckoutIntent.findOne({
        _id: input.intent._id,
        userId: input.intent.userId,
        providerMode: input.intent.providerMode,
      }).select({
        status: 1,
        remoteCreationLeaseToken: 1,
        remoteCreationLeaseExpiresAt: 1,
      }).lean<{
        status: CheckoutIntentStatus
        remoteCreationLeaseToken?: string
        remoteCreationLeaseExpiresAt?: Date
      }>()
      const activeLease =
        leaseState !== null &&
        REMOTE_CREATABLE_INTENT_STATUSES.includes(leaseState.status) &&
        typeof leaseState.remoteCreationLeaseToken === 'string' &&
        (
          leaseState.remoteCreationLeaseExpiresAt === undefined ||
          leaseState.remoteCreationLeaseExpiresAt > input.claimedAt
        )
      return { outcome: activeLease ? 'busy' : 'conflict' }
    }

    const claimedIntent = toTrustedIntent(current)
    if (!sameCommercialIntent(claimedIntent, input.intent)) {
      await markMongoIntentReview(claimedIntent, input.claimToken)
      return { outcome: 'conflict' }
    }
    return {
      outcome: 'claimed',
      intent: claimedIntent,
      recoveryOnly: current.remoteCreationStartedAt !== undefined,
    }
  },

  async markRemoteCreationStarted(input) {
    await connectDB()
    const update = await CheckoutIntent.updateOne(
      {
        _id: input.intent._id,
        userId: input.intent.userId,
        providerMode: input.intent.providerMode,
        status: { $in: REMOTE_CREATABLE_INTENT_STATUSES },
        remoteCreationLeaseToken: input.claimToken,
        remoteCreationLeaseExpiresAt: { $gt: input.startedAt },
        remoteCreationStartedAt: { $exists: false },
      },
      {
        $set: {
          remoteCreationStartedAt: input.startedAt,
          remoteCreationLeaseExpiresAt: input.leaseExpiresAt,
        },
      },
      { runValidators: true, writeConcern: { w: 'majority' } },
    )
    return update.matchedCount === 1
  },

  async releaseRemoteCreationClaim(input) {
    await connectDB()
    await CheckoutIntent.updateOne(
      {
        _id: input.intent._id,
        userId: input.intent.userId,
        providerMode: input.intent.providerMode,
        status: { $in: REMOTE_CREATABLE_INTENT_STATUSES },
        remoteCreationLeaseToken: input.claimToken,
      },
      {
        $unset: {
          remoteCreationLeaseToken: 1,
          remoteCreationLeaseExpiresAt: 1,
        },
      },
      { runValidators: true, writeConcern: { w: 'majority' } },
    )
  },

  async attachRemoteId(input) {
    await connectDB()
    const session = await mongoose.startSession()
    let result: RemoteCheckoutAttachResult | undefined
    try {
      await session.withTransaction(async () => {
        const current = await loadMongoIntent(
          input.intent._id,
          input.intent.userId,
          session,
        )
        const ownsClaim = await CheckoutIntent.exists({
          _id: input.intent._id,
          userId: input.intent.userId,
          providerMode: input.intent.providerMode,
          status: { $in: REMOTE_CREATABLE_INTENT_STATUSES },
          remoteCreationLeaseToken: input.claimToken,
        }).session(session)
        if (
          !current ||
          !ownsClaim ||
          !sameCommercialIntent(current, input.intent) ||
          !REMOTE_CREATABLE_INTENT_STATUSES.includes(current.status)
        ) {
          if (current && ownsClaim) {
            await markReviewInSession(
              current,
              input.claimToken,
              session,
            )
          }
          result = { outcome: 'conflict' }
          return
        }

        const localRemoteId = current.kind === 'subscription'
          ? current.razorpaySubscriptionId
          : current.razorpayOrderId
        if (localRemoteId && localRemoteId !== input.remoteId) {
          await markReviewInSession(
            current,
            input.claimToken,
            session,
          )
          result = { outcome: 'conflict' }
          return
        }

        if (current.kind === 'subscription') {
          const lease = await ConsumerSubscriptionLease.findOne({
            userId: current.userId,
            providerMode: current.providerMode,
            ownerCheckoutIntentId: current._id,
            lane: current.leaseLane,
          }).session(session).lean<LeanSubscriptionLease>()
          if (
            !lease ||
            lease.lane !== current.leaseLane ||
            lease.status !== 'held' ||
            (
              lease.razorpaySubscriptionId !== undefined &&
              lease.razorpaySubscriptionId !== input.remoteId
            )
          ) {
            await markReviewInSession(
              current,
              input.claimToken,
              session,
            )
            result = { outcome: 'conflict' }
            return
          }
          const leaseUpdate = await ConsumerSubscriptionLease.updateOne(
            {
              _id: lease._id,
              userId: current.userId,
              providerMode: current.providerMode,
              ownerCheckoutIntentId: current._id,
              lane: current.leaseLane,
              status: 'held',
              $or: [
                { razorpaySubscriptionId: { $exists: false } },
                { razorpaySubscriptionId: input.remoteId },
              ],
            },
            { $set: { razorpaySubscriptionId: input.remoteId } },
            { session, runValidators: true },
          )
          if (leaseUpdate.matchedCount !== 1) {
            await markReviewInSession(
              current,
              input.claimToken,
              session,
            )
            result = { outcome: 'conflict' }
            return
          }
        }

        const remoteField = current.kind === 'subscription'
          ? 'razorpaySubscriptionId'
          : 'razorpayOrderId'
        const intentUpdate = await CheckoutIntent.updateOne(
          {
            _id: current._id,
            userId: current.userId,
            providerMode: current.providerMode,
            status: current.status,
            remoteCreationLeaseToken: input.claimToken,
            $or: [
              { [remoteField]: { $exists: false } },
              { [remoteField]: input.remoteId },
            ],
          },
          {
            $set: {
              [remoteField]: input.remoteId,
              status: 'remote_created',
            },
            $unset: {
              nextRecoveryAt: 1,
              remoteCreationLeaseToken: 1,
              remoteCreationLeaseExpiresAt: 1,
              remoteCreationStartedAt: 1,
            },
          },
          { session, runValidators: true },
        )
        if (intentUpdate.matchedCount !== 1) {
          await markReviewInSession(
            current,
            input.claimToken,
            session,
          )
          result = { outcome: 'conflict' }
          return
        }
        result = {
          outcome: localRemoteId ? 'reused' : 'attached',
          remoteId: input.remoteId,
        }
      }, {
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      })
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error
      await markMongoIntentReview(input.intent, input.claimToken)
      return { outcome: 'conflict' }
    } finally {
      await session.endSession()
    }
    if (!result) {
      throw failure(
        'persistence_conflict',
        'Remote checkout attach transaction returned no result',
      )
    }
    return result
  },

  async markReview(input) {
    return markMongoIntentReview(input.intent, input.claimToken)
  },
}

/**
 * Creates no remote object unless the server-evaluated sale gate is allowed.
 * With CURRENT_PAYMENT_CODE_READINESS, this remains inert by construction.
 */
export async function createOrReuseRemoteCheckout(
  input: RemoteCheckoutCreationInput,
  dependencies: RemoteCheckoutCreationDependencies = {},
): Promise<RemoteCheckoutCreationResult> {
  const userId = parseObjectId(input.userId, 'userId')
  const intentId = parseObjectId(input.intentId, 'intentId')
  const evaluateSaleGate =
    dependencies.evaluateSaleGate ?? defaultEvaluateSaleGate

  let saleGate: PaymentSaleGate
  try {
    saleGate = await evaluateSaleGate(userId.toString())
  } catch (error) {
    throw failure(
      'sale_blocked',
      'Payment sale gate could not be evaluated',
      error,
    )
  }
  if (!saleGate.allowed) {
    throw new RemoteCheckoutCreationError(
      'sale_blocked',
      'Remote payment creation is currently disabled',
      { saleBlockReason: saleGate.reason },
    )
  }

  const store = dependencies.store ?? mongoRemoteCheckoutCreationStore
  let intent: TrustedRemoteCheckoutIntent | null
  try {
    intent = await store.loadIntentForUser({ intentId, userId })
  } catch (error) {
    if (error instanceof CheckoutBlockedByAccountDeletionError) {
      throw new RemoteCheckoutCreationError(
        'sale_blocked',
        'Remote payment creation is unavailable while account deletion is pending',
        { saleBlockReason: 'buyer_deletion_pending' },
      )
    }
    throw failure(
      'persistence_conflict',
      'Checkout intent could not be claimed for remote creation',
      error,
    )
  }
  if (!intent) {
    throw failure(
      'intent_not_found',
      'Checkout intent was not found for the authenticated user',
    )
  }
  assertIntentShape(intent)
  if (intent.providerMode !== saleGate.providerMode) {
    throw failure(
      'intent_mode_mismatch',
      'Sale gate mode does not match the checkout intent',
    )
  }

  const spec = intent.kind === 'subscription'
    ? await resolveTrustedSubscriptionSpec(
        intent,
        dependencies.resolveSubscriptionSpec,
      )
    : undefined

  const clientFactory = dependencies.clientFactory ?? defaultClientFactory
  let adapter: RazorpayServerAdapter
  try {
    adapter = clientFactory.forMode(intent.providerMode)
  } catch (error) {
    throw failure(
      'provider_unavailable',
      'Razorpay client is unavailable for the checkout mode',
      error,
    )
  }
  assertAdapterMode(adapter, intent.providerMode)

  const now = dependencies.now ?? (() => new Date())
  const claimedAt = now()
  if (Number.isNaN(claimedAt.getTime())) {
    throw failure('invalid_request', 'Current time is invalid')
  }
  const claimToken = randomUUID()
  let claim: RemoteCheckoutCreationClaimResult
  try {
    claim = await store.claimRemoteCreation({
      intent,
      claimToken,
      claimedAt,
      leaseExpiresAt: new Date(
        claimedAt.getTime() + REMOTE_CREATION_LEASE_MS,
      ),
    })
  } catch (error) {
    throw failure(
      'persistence_conflict',
      'Remote creation claim could not be persisted',
      error,
    )
  }
  if (claim.outcome !== 'claimed') {
    if (claim.outcome === 'busy') {
      throw failure(
        'provider_unavailable',
        'Remote checkout creation is already in progress',
      )
    }
    throw failure(
      'persistence_conflict',
      'Checkout intent changed before remote creation could be claimed',
    )
  }

  const claimedIntent = claim.intent
  const lease: AcquiredRemoteCreationLease = {
    claimToken,
    recoveryOnly: claim.recoveryOnly,
    providerCreationAttempted: false,
  }
  try {
    assertIntentShape(claimedIntent)
    if (!sameCommercialIntent(claimedIntent, intent)) {
      return reviewAndThrow(
        store,
        claimedIntent,
        lease,
        failure(
          'persistence_conflict',
          'Claimed checkout intent no longer matches its commercial snapshot',
        ),
      )
    }
    if (claimedIntent.kind === 'subscription' && spec) {
      return await createOrRecoverSubscription({
        adapter,
        store,
        intent: claimedIntent,
        lease,
        spec,
        recoveryNow: claimedAt,
        now,
      })
    }
    return await createOrRecoverOrder({
      adapter,
      store,
      intent: claimedIntent,
      lease,
      now,
    })
  } catch (error) {
    if (!lease.providerCreationAttempted) {
      try {
        await store.releaseRemoteCreationClaim({
          intent: claimedIntent,
          claimToken,
        })
      } catch (releaseError) {
        throw failure(
          'persistence_conflict',
          'Remote creation claim could not be released safely',
          releaseError,
        )
      }
    }
    throw error
  }
}
