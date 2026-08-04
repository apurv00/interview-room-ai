import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  CheckoutIntent,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import type {
  ConsumerSubscriptionLeaseLane,
} from '../models/ConsumerSubscriptionLease'
import {
  Subscription,
  type SubscriptionSource,
  type SubscriptionStatus,
} from '../models/Subscription'
import {
  createRazorpayClientFactory,
  type RazorpayClientFactory,
} from '../providers/razorpayClientFactory'
import type {
  RazorpayInvoiceDto,
  RazorpayOrderDto,
  RazorpayPaymentDto,
  RazorpayRefundDto,
  RazorpayServerAdapter,
  RazorpaySubscriptionDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import {
  CapturedCheckoutVerificationError,
  persistServerFetchedCapturedCheckout,
  type CapturedCheckoutVerificationResult,
  type PersistServerFetchedCapturedCheckoutDependencies,
  type TrustedCheckoutIntentForCapture,
} from './capturedCheckoutVerificationService'
import type {
  PaymentWebhookHandler,
  VerifiedPaymentWebhookEnvelope,
} from './webhookProcessingService'
import {
  parseVerifiedWebhookReferences,
  WebhookReferenceParseError,
  type DisputeWebhookReferences,
  type NormalizedRazorpayWebhookReferences,
  type PaymentWebhookReferences,
  type RefundWebhookReferences,
  type SubscriptionChargedWebhookReferences,
  type SubscriptionStateWebhookReferences,
} from './webhookReferenceParser'

export const WEBHOOK_DOMAIN_DISPATCH_ERROR_CODES = [
  'references_invalid',
  'provider_unavailable',
  'provider_mode_mismatch',
  'provider_reference_mismatch',
  'provider_state_not_ready',
  'local_store_unavailable',
  'local_mapping_missing',
  'local_mapping_mismatch',
  'financial_entity_reader_missing',
  'effect_handler_missing',
  'effect_failed',
  'effect_not_acknowledged',
  'capture_persistence_failed',
] as const
export type WebhookDomainDispatchErrorCode =
  (typeof WEBHOOK_DOMAIN_DISPATCH_ERROR_CODES)[number]

export type WebhookDomainDispatchDisposition = 'retry' | 'review'

export class WebhookDomainDispatchError extends Error {
  readonly code: WebhookDomainDispatchErrorCode
  readonly disposition: WebhookDomainDispatchDisposition
  readonly retryable: boolean

  constructor(
    code: WebhookDomainDispatchErrorCode,
    disposition: WebhookDomainDispatchDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WebhookDomainDispatchError'
    this.code = code
    this.disposition = disposition
    this.retryable = disposition === 'retry'
  }
}

export interface TrustedOneTimeWebhookIntent
  extends TrustedCheckoutIntentForCapture {
  kind: 'single_interview' | 'premium_resume'
  razorpayOrderId: string
  receipt: string
}

export interface TrustedSubscriptionWebhookCheckout {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId: string
  receipt: string
}

export interface TrustedWebhookSubscription {
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
  source: SubscriptionSource
}

export interface TrustedWebhookSubscriptionContext {
  checkout?: TrustedSubscriptionWebhookCheckout
  subscription?: TrustedWebhookSubscription
}

export interface WebhookDomainMappingStore {
  loadOneTimeIntentByOrder(input: {
    providerMode: ProviderMode
    razorpayOrderId: string
  }): Promise<TrustedOneTimeWebhookIntent | null>
  loadSubscriptionContext(input: {
    providerMode: ProviderMode
    razorpaySubscriptionId: string
  }): Promise<TrustedWebhookSubscriptionContext | null>
}

export interface WebhookDomainEffectAcknowledgement {
  outcome: 'handled'
  operationKey: string
}

export interface RazorpayWebhookRefundDto {
  providerMode: ProviderMode
  id: string
  paymentId: string
  status: string
  amountPaise: number
  currency: 'INR'
}

export interface RazorpayWebhookDisputeDto {
  providerMode: ProviderMode
  id: string
  paymentId: string
  status: string
  amountPaise: number
  currency: 'INR'
}

export interface RazorpayWebhookFinancialEntityReader {
  fetchRefund(input: {
    providerMode: ProviderMode
    razorpayRefundId: string
  }): Promise<RazorpayWebhookRefundDto>
  fetchDispute(input: {
    providerMode: ProviderMode
    razorpayDisputeId: string
  }): Promise<RazorpayWebhookDisputeDto>
}

export type WebhookPaymentDomainTarget =
  | {
      kind: 'one_time_checkout'
      intent: TrustedOneTimeWebhookIntent
      order: RazorpayOrderDto
    }
  | {
      kind: 'subscription'
      context: TrustedWebhookSubscriptionContext
      subscription: RazorpaySubscriptionDto
    }

export interface PaymentStateEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType:
    | 'payment.authorized'
    | 'payment.captured'
    | 'payment.failed'
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  payment: RazorpayPaymentDto
  target: WebhookPaymentDomainTarget
}

export interface FutureSubscriptionAuthorizationEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: PaymentStateEffectInput['eventType']
  razorpayPaymentId: string
  razorpaySubscriptionId: string
  payment: RazorpayPaymentDto
  target: Extract<WebhookPaymentDomainTarget, { kind: 'subscription' }>
}

export interface SubscriptionChargedEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: 'subscription.charged'
  razorpaySubscriptionId: string
  razorpayPaymentId: string
  razorpayInvoiceId: string
  razorpayOrderId?: string
  subscription: RazorpaySubscriptionDto
  payment: RazorpayPaymentDto
  invoice: RazorpayInvoiceDto
  localContext: TrustedWebhookSubscriptionContext
}

export interface SubscriptionStateEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: SubscriptionStateWebhookReferences['eventType']
  providerObservedAt: Date
  razorpaySubscriptionId: string
  razorpayPaymentId?: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  subscription: RazorpaySubscriptionDto
  payment?: RazorpayPaymentDto
  localContext: TrustedWebhookSubscriptionContext
}

export interface RefundEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: RefundWebhookReferences['eventType']
  razorpayRefundId: string
  razorpayPaymentId: string
  refund: RazorpayWebhookRefundDto
  payment: RazorpayPaymentDto
  target: WebhookPaymentDomainTarget
}

export interface DisputeEffectInput {
  inboxEventId: string
  providerMode: ProviderMode
  eventType: DisputeWebhookReferences['eventType']
  razorpayDisputeId: string
  razorpayPaymentId: string
  dispute: RazorpayWebhookDisputeDto
  payment: RazorpayPaymentDto
  target: WebhookPaymentDomainTarget
}

export interface WebhookDomainEffectHandlers {
  handlePaymentState?: (
    input: PaymentStateEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
  handleFutureSubscriptionAuthorization?: (
    input: FutureSubscriptionAuthorizationEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
  handleSubscriptionCharged?: (
    input: SubscriptionChargedEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
  handleSubscriptionState?: (
    input: SubscriptionStateEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
  handleRefund?: (
    input: RefundEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
  handleDispute?: (
    input: DisputeEffectInput,
  ) => Promise<WebhookDomainEffectAcknowledgement>
}

export type PersistOneTimeWebhookCapture = (
  input: Parameters<typeof persistServerFetchedCapturedCheckout>[0],
  dependencies?: PersistServerFetchedCapturedCheckoutDependencies,
) => Promise<CapturedCheckoutVerificationResult>

export interface WebhookDomainDispatchDependencies {
  clientFactory?: RazorpayClientFactory
  store?: WebhookDomainMappingStore
  effects?: WebhookDomainEffectHandlers
  financialEntityReader?: RazorpayWebhookFinancialEntityReader
  persistOneTimeCapture?: PersistOneTimeWebhookCapture
  capturedCheckoutDependencies?:
    PersistServerFetchedCapturedCheckoutDependencies
}

export type WebhookDomainHandledEffect =
  | 'payment_state'
  | 'future_subscription_authorization'
  | 'subscription_charged'
  | 'subscription_state'
  | 'refund'
  | 'dispute'

export type WebhookDomainDispatchResult =
  | {
      outcome: 'one_time_capture_persisted'
      eventType: 'order.paid' | 'payment.captured'
      providerMode: ProviderMode
      razorpayPaymentId: string
      razorpayOrderId: string
      reused: boolean
      fulfillmentStatus:
        CapturedCheckoutVerificationResult['fulfillmentStatus']
    }
  | {
      outcome: 'effect_handled'
      effect: WebhookDomainHandledEffect
      eventType: NormalizedRazorpayWebhookReferences['eventType']
      providerMode: ProviderMode
      operationKey: string
    }
  | {
      outcome: 'ignored_safe'
      reason: 'subscription_charged_is_authoritative'
      eventType: 'order.paid' | 'payment.captured'
      providerMode: ProviderMode
      razorpayPaymentId: string
      razorpaySubscriptionId: string
    }

interface LeanOneTimeCheckoutIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'single_interview' | 'premium_resume'
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  quoteSnapshot: {
    payablePaise: number
    currency: 'INR'
  }
  razorpayOrderId: string
  receipt: string
}

interface LeanSubscriptionCheckout {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpaySubscriptionId: string
  receipt: string
}

interface LeanWebhookSubscription {
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
  source: SubscriptionSource
}

const defaultClientFactory = createRazorpayClientFactory()

function failure(
  code: WebhookDomainDispatchErrorCode,
  disposition: WebhookDomainDispatchDisposition,
  message: string,
  cause?: unknown,
): WebhookDomainDispatchError {
  return new WebhookDomainDispatchError(
    code,
    disposition,
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

function toOneTimeIntent(
  intent: LeanOneTimeCheckoutIntent,
): TrustedOneTimeWebhookIntent {
  return {
    _id: intent._id,
    userId: intent.userId,
    kind: intent.kind,
    providerMode: intent.providerMode,
    status: intent.status,
    payablePaise: intent.quoteSnapshot.payablePaise,
    currency: intent.quoteSnapshot.currency,
    razorpayOrderId: intent.razorpayOrderId,
    receipt: intent.receipt,
  }
}

function toSubscriptionCheckout(
  checkout: LeanSubscriptionCheckout,
): TrustedSubscriptionWebhookCheckout {
  return {
    _id: checkout._id,
    userId: checkout.userId,
    providerMode: checkout.providerMode,
    status: checkout.status,
    purpose: checkout.purpose,
    planChangeRequestId: checkout.planChangeRequestId,
    leaseLane: checkout.leaseLane,
    requestedStartAt: checkout.requestedStartAt,
    authorizationExpiresAt: checkout.authorizationExpiresAt,
    planKey: checkout.planKey,
    catalogVersion: checkout.catalogVersion,
    razorpaySubscriptionId: checkout.razorpaySubscriptionId,
    receipt: checkout.receipt,
  }
}

function toWebhookSubscription(
  subscription: LeanWebhookSubscription,
): TrustedWebhookSubscription {
  return {
    _id: subscription._id,
    userId: subscription.userId,
    providerMode: subscription.providerMode,
    planKey: subscription.planKey,
    catalogVersion: subscription.catalogVersion,
    razorpayPlanId: subscription.razorpayPlanId,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    checkoutIntentId: subscription.checkoutIntentId,
    planChangeRequestId: subscription.planChangeRequestId,
    replacesSubscriptionId: subscription.replacesSubscriptionId,
    leaseLane: subscription.leaseLane,
    requestedStartAt: subscription.requestedStartAt,
    authorizationExpiresAt: subscription.authorizationExpiresAt,
    status: subscription.status,
    source: subscription.source,
  }
}

export const mongoWebhookDomainMappingStore:
WebhookDomainMappingStore = {
  async loadOneTimeIntentByOrder(input) {
    await connectDB()
    const intent = await CheckoutIntent.findOne({
      providerMode: input.providerMode,
      razorpayOrderId: input.razorpayOrderId,
      kind: { $in: ['single_interview', 'premium_resume'] },
    }).select({
      _id: 1,
      userId: 1,
      kind: 1,
      providerMode: 1,
      status: 1,
      quoteSnapshot: 1,
      razorpayOrderId: 1,
      receipt: 1,
    }).lean<LeanOneTimeCheckoutIntent>()
    return intent ? toOneTimeIntent(intent) : null
  },

  async loadSubscriptionContext(input) {
    await connectDB()
    const [checkout, subscription] = await Promise.all([
      CheckoutIntent.findOne({
        providerMode: input.providerMode,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
        kind: 'subscription',
      }).select({
        _id: 1,
        userId: 1,
        providerMode: 1,
        status: 1,
        purpose: 1,
        planChangeRequestId: 1,
        leaseLane: 1,
        requestedStartAt: 1,
        authorizationExpiresAt: 1,
        planKey: 1,
        catalogVersion: 1,
        razorpaySubscriptionId: 1,
        receipt: 1,
      }).lean<LeanSubscriptionCheckout>(),
      Subscription.findOne({
        providerMode: input.providerMode,
        razorpaySubscriptionId: input.razorpaySubscriptionId,
      }).select({
        _id: 1,
        userId: 1,
        providerMode: 1,
        planKey: 1,
        catalogVersion: 1,
        razorpayPlanId: 1,
        razorpaySubscriptionId: 1,
        checkoutIntentId: 1,
        planChangeRequestId: 1,
        replacesSubscriptionId: 1,
        leaseLane: 1,
        requestedStartAt: 1,
        authorizationExpiresAt: 1,
        status: 1,
        source: 1,
      }).lean<LeanWebhookSubscription>(),
    ])
    if (!checkout && !subscription) return null
    return {
      ...(checkout
        ? { checkout: toSubscriptionCheckout(checkout) }
        : {}),
      ...(subscription
        ? { subscription: toWebhookSubscription(subscription) }
        : {}),
    }
  },
}

function adapterForMode(
  providerMode: ProviderMode,
  clientFactory: RazorpayClientFactory,
): RazorpayServerAdapter {
  let adapter: RazorpayServerAdapter
  try {
    adapter = clientFactory.forMode(providerMode)
  } catch (error) {
    throw failure(
      'provider_unavailable',
      'retry',
      'Razorpay client is unavailable for the verified webhook mode',
      error,
    )
  }
  if (adapter.providerMode !== providerMode) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Razorpay client mode does not match the verified webhook mode',
    )
  }
  return adapter
}

async function fetchProviderEntity<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WebhookDomainDispatchError) throw error
    throw failure(
      'provider_unavailable',
      'retry',
      'Razorpay entity could not be fetched for verified webhook processing',
      error,
    )
  }
}

async function loadLocalMapping<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WebhookDomainDispatchError) throw error
    throw failure(
      'local_store_unavailable',
      'retry',
      'Local payment correlation could not be loaded',
      error,
    )
  }
}

function assertPaymentReferences(
  references: {
    providerMode: ProviderMode
    razorpayPaymentId: string
    razorpayOrderId?: string
    razorpayInvoiceId?: string
  },
  payment: RazorpayPaymentDto,
): void {
  if (payment.providerMode !== references.providerMode) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Fetched payment mode does not match the verified webhook mode',
    )
  }
  if (
    payment.id !== references.razorpayPaymentId ||
    (
      references.razorpayOrderId !== undefined &&
      payment.orderId !== references.razorpayOrderId
    ) ||
    (
      references.razorpayInvoiceId !== undefined &&
      payment.invoiceId !== references.razorpayInvoiceId
    )
  ) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      'Fetched payment references do not match the verified webhook',
    )
  }
}

function assertOrderIdentity(
  providerMode: ProviderMode,
  razorpayOrderId: string,
  order: RazorpayOrderDto,
): void {
  if (order.providerMode !== providerMode) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Fetched order mode does not match the verified webhook mode',
    )
  }
  if (order.id !== razorpayOrderId) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      'Fetched order does not match the verified webhook',
    )
  }
}

function assertOneTimeOrderMapping(input: {
  intent: TrustedOneTimeWebhookIntent
  order: RazorpayOrderDto
  payment: RazorpayPaymentDto
}): void {
  const { intent, order, payment } = input
  if (
    intent.providerMode !== order.providerMode ||
    intent.razorpayOrderId !== order.id ||
    intent.receipt !== order.receipt ||
    order.currency !== intent.currency ||
    order.amountPaise !== intent.payablePaise ||
    payment.orderId !== order.id ||
    payment.subscriptionId !== undefined ||
    payment.currency !== intent.currency ||
    payment.amountPaise !== intent.payablePaise
  ) {
    throw failure(
      'local_mapping_mismatch',
      'review',
      'One-time checkout mapping conflicts with fetched Razorpay entities',
    )
  }
}

function assertPaidOneTimeOrder(order: RazorpayOrderDto): void {
  if (
    order.status !== 'paid' ||
    order.amountDuePaise !== 0 ||
    order.amountPaidPaise !== order.amountPaise
  ) {
    throw failure(
      'provider_state_not_ready',
      'retry',
      'Razorpay order is not yet in a fully paid state',
    )
  }
}

function assertSubscriptionIdentity(
  providerMode: ProviderMode,
  razorpaySubscriptionId: string,
  subscription: RazorpaySubscriptionDto,
): void {
  if (subscription.providerMode !== providerMode) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Fetched subscription mode does not match the verified webhook mode',
    )
  }
  if (subscription.id !== razorpaySubscriptionId) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      'Fetched subscription does not match the verified webhook',
    )
  }
}

function assertPaidSubscriptionInvoice(input: {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  payment: RazorpayPaymentDto & { invoiceId: string }
  invoice: RazorpayInvoiceDto
}): void {
  const { providerMode, razorpaySubscriptionId, payment, invoice } = input
  if (
    invoice.providerMode !== providerMode ||
    invoice.currency !== 'INR'
  ) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Fetched invoice mode or currency does not match the webhook',
    )
  }
  if (
    invoice.id !== payment.invoiceId ||
    invoice.subscriptionId !== razorpaySubscriptionId ||
    invoice.paymentId !== payment.id ||
    invoice.orderId !== payment.orderId
  ) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      'Fetched invoice does not match the charged payment and subscription',
    )
  }
  if (
    invoice.status !== 'paid' ||
    invoice.partialPayment ||
    invoice.amountDuePaise !== 0 ||
    invoice.amountPaise !== payment.amountPaise ||
    invoice.amountPaidPaise !== payment.amountPaise ||
    invoice.billingStartEpochSeconds === undefined ||
    invoice.billingEndEpochSeconds === undefined
  ) {
    throw failure(
      'provider_state_not_ready',
      invoice.status === 'draft' ||
      invoice.status === 'issued' ||
      invoice.status === 'partially_paid'
        ? 'retry'
        : 'review',
      'Subscription charge is not backed by a fully paid bounded invoice',
    )
  }
}

function exactOptionalObjectId(
  left: mongoose.Types.ObjectId | undefined,
  right: mongoose.Types.ObjectId | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function exactOptionalDate(
  left: Date | undefined,
  right: Date | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    Number.isFinite(left.getTime()) &&
    Number.isFinite(right.getTime()) &&
    left.getTime() === right.getTime()
  )
}

function validLifecycleDate(value: Date | undefined): value is Date {
  return Boolean(
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getMilliseconds() === 0,
  )
}

function checkoutLifecycleIsExact(
  checkout: TrustedSubscriptionWebhookCheckout,
  remote: RazorpaySubscriptionDto,
): boolean {
  if (
    !checkout.purpose ||
    !checkout.leaseLane ||
    !validLifecycleDate(checkout.authorizationExpiresAt)
  ) {
    return false
  }
  const acquisition = checkout.purpose === 'acquisition'
  if (
    acquisition
      ? (
          checkout.leaseLane !== 'a' ||
          checkout.planChangeRequestId !== undefined ||
          checkout.requestedStartAt !== undefined
        )
      : (
          !(checkout.planChangeRequestId instanceof
            mongoose.Types.ObjectId) ||
          !validLifecycleDate(checkout.requestedStartAt) ||
          checkout.authorizationExpiresAt >= checkout.requestedStartAt
        )
  ) {
    return false
  }
  const expectedStart = checkout.requestedStartAt
    ? Math.floor(checkout.requestedStartAt.getTime() / 1_000)
    : undefined
  const expectedExpiry = Math.floor(
    checkout.authorizationExpiresAt.getTime() / 1_000,
  )
  return (
    remote.notes.checkout_receipt === checkout.receipt &&
    remote.notes.checkout_intent_id === checkout._id.toString() &&
    remote.notes.catalog_version === checkout.catalogVersion &&
    remote.notes.checkout_purpose === checkout.purpose &&
    remote.notes.subscription_lease_lane === checkout.leaseLane &&
    remote.notes.plan_change_request_id ===
      checkout.planChangeRequestId?.toString() &&
    remote.startAtEpochSeconds === expectedStart &&
    remote.authorizationExpiresAtEpochSeconds === expectedExpiry
  )
}

function localSubscriptionLineageIsExact(
  checkout: TrustedSubscriptionWebhookCheckout,
  subscription: TrustedWebhookSubscription,
): boolean {
  const future = checkout.purpose !== 'acquisition'
  return (
    subscription.checkoutIntentId instanceof
      mongoose.Types.ObjectId &&
    subscription.checkoutIntentId.equals(checkout._id) &&
    exactOptionalObjectId(
      subscription.planChangeRequestId,
      checkout.planChangeRequestId,
    ) &&
    (
      future
        ? subscription.replacesSubscriptionId instanceof
          mongoose.Types.ObjectId
        : subscription.replacesSubscriptionId === undefined
    ) &&
    subscription.leaseLane === checkout.leaseLane &&
    exactOptionalDate(
      subscription.requestedStartAt,
      checkout.requestedStartAt,
    ) &&
    exactOptionalDate(
      subscription.authorizationExpiresAt,
      checkout.authorizationExpiresAt,
    )
  )
}

function assertSubscriptionContext(input: {
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  remote: RazorpaySubscriptionDto
  context: TrustedWebhookSubscriptionContext
}): void {
  const { providerMode, razorpaySubscriptionId, remote, context } = input
  if (!context.checkout && !context.subscription) {
    throw failure(
      'local_mapping_missing',
      'retry',
      'Verified subscription webhook has no local correlation',
    )
  }
  const checkout = context.checkout
  if (
    checkout &&
    (
      checkout.providerMode !== providerMode ||
      checkout.razorpaySubscriptionId !== razorpaySubscriptionId ||
      !checkoutLifecycleIsExact(checkout, remote)
    )
  ) {
    throw failure(
      'local_mapping_mismatch',
      'review',
      'Subscription checkout correlation conflicts with Razorpay',
    )
  }
  const local = context.subscription
  if (!checkout && local?.source === 'customer') {
    throw failure(
      'local_mapping_mismatch',
      'review',
      'Customer subscription lacks its immutable checkout lineage',
    )
  }
  if (
    local &&
    (
      local.providerMode !== providerMode ||
      local.razorpaySubscriptionId !== razorpaySubscriptionId ||
      local.razorpayPlanId !== remote.planId ||
      (
        local.source === 'customer' &&
        (
          !checkout ||
          !localSubscriptionLineageIsExact(checkout, local)
        )
      )
    )
  ) {
    throw failure(
      'local_mapping_mismatch',
      'review',
      'Local subscription conflicts with fetched Razorpay state',
    )
  }
  if (
    checkout &&
    local &&
    (
      !sameObjectId(checkout.userId, local.userId) ||
      checkout.planKey !== local.planKey ||
      checkout.catalogVersion !== local.catalogVersion ||
      local.source !== 'customer'
    )
  ) {
    throw failure(
      'local_mapping_mismatch',
      'review',
      'Subscription checkout and local subscription disagree',
    )
  }
}

async function loadAndAssertSubscriptionContext(input: {
  store: WebhookDomainMappingStore
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  remote: RazorpaySubscriptionDto
}): Promise<TrustedWebhookSubscriptionContext> {
  const context = await loadLocalMapping(() => (
    input.store.loadSubscriptionContext({
      providerMode: input.providerMode,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
    })
  ))
  if (!context) {
    throw failure(
      'local_mapping_missing',
      'retry',
      'Verified subscription webhook has no local correlation',
    )
  }
  assertSubscriptionContext({ ...input, context })
  return context
}

async function invokeEffect<T>(
  effect: WebhookDomainHandledEffect,
  handler: ((input: T) => Promise<WebhookDomainEffectAcknowledgement>)
    | undefined,
  input: T,
): Promise<WebhookDomainEffectAcknowledgement> {
  if (!handler) {
    throw failure(
      'effect_handler_missing',
      'review',
      `Webhook ${effect} effect handler is not configured`,
    )
  }
  let acknowledgement: WebhookDomainEffectAcknowledgement
  try {
    acknowledgement = await handler(input)
  } catch (error) {
    if (error instanceof WebhookDomainDispatchError) throw error
    throw failure(
      'effect_failed',
      'retry',
      `Webhook ${effect} effect did not complete`,
      error,
    )
  }
  if (
    !acknowledgement ||
    acknowledgement.outcome !== 'handled' ||
    typeof acknowledgement.operationKey !== 'string' ||
    acknowledgement.operationKey.trim().length === 0 ||
    acknowledgement.operationKey.length > 255
  ) {
    throw failure(
      'effect_not_acknowledged',
      'review',
      `Webhook ${effect} effect did not return a durable acknowledgement`,
    )
  }
  return acknowledgement
}

async function persistOneTimeCapture(input: {
  eventType: 'order.paid' | 'payment.captured'
  intent: TrustedOneTimeWebhookIntent
  order: RazorpayOrderDto
  payment: RazorpayPaymentDto
  persist: PersistOneTimeWebhookCapture
  capturedCheckoutDependencies?:
    PersistServerFetchedCapturedCheckoutDependencies
}): Promise<WebhookDomainDispatchResult> {
  assertPaidOneTimeOrder(input.order)
  if (
    input.payment.status !== 'captured' ||
    input.payment.captured !== true
  ) {
    throw failure(
      'provider_state_not_ready',
      'retry',
      'Razorpay payment is not yet captured',
    )
  }
  let result: CapturedCheckoutVerificationResult
  try {
    result = await input.persist(
      {
        intent: input.intent,
        payment: input.payment,
        requestedPaymentId: input.payment.id,
        expectedKind: 'order',
      },
      input.capturedCheckoutDependencies,
    )
  } catch (error) {
    if (error instanceof WebhookDomainDispatchError) throw error
    if (
      error instanceof CapturedCheckoutVerificationError &&
      error.code === 'payment_capture_pending'
    ) {
      throw failure(
        'provider_state_not_ready',
        'retry',
        'Razorpay payment capture is still pending',
        error,
      )
    }
    throw failure(
      'capture_persistence_failed',
      error instanceof CapturedCheckoutVerificationError
        ? 'review'
        : 'retry',
      'One-time captured payment could not be persisted',
      error,
    )
  }
  return {
    outcome: 'one_time_capture_persisted',
    eventType: input.eventType,
    providerMode: input.intent.providerMode,
    razorpayPaymentId: input.payment.id,
    razorpayOrderId: input.order.id,
    reused: result.reused,
    fulfillmentStatus: result.fulfillmentStatus,
  }
}

async function resolvePaymentTarget(input: {
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  payment: RazorpayPaymentDto
}): Promise<WebhookPaymentDomainTarget> {
  const { adapter, store, payment } = input
  if (payment.subscriptionId) {
    const subscription = await fetchProviderEntity(() => (
      adapter.fetchSubscription(payment.subscriptionId as string)
    ))
    assertSubscriptionIdentity(
      payment.providerMode,
      payment.subscriptionId,
      subscription,
    )
    const context = await loadAndAssertSubscriptionContext({
      store,
      providerMode: payment.providerMode,
      razorpaySubscriptionId: payment.subscriptionId,
      remote: subscription,
    })
    return {
      kind: 'subscription',
      context,
      subscription,
    }
  }
  if (payment.orderId) {
    const order = await fetchProviderEntity(() => (
      adapter.fetchOrder(payment.orderId as string)
    ))
    assertOrderIdentity(payment.providerMode, payment.orderId, order)
    const intent = await loadLocalMapping(() => (
      store.loadOneTimeIntentByOrder({
        providerMode: payment.providerMode,
        razorpayOrderId: payment.orderId as string,
      })
    ))
    if (!intent) {
      throw failure(
        'local_mapping_missing',
        'retry',
        'Verified payment has no one-time checkout correlation',
      )
    }
    assertOneTimeOrderMapping({ intent, order, payment })
    return {
      kind: 'one_time_checkout',
      intent,
      order,
    }
  }
  throw failure(
    'local_mapping_missing',
    'retry',
    'Verified payment has no supported local correlation',
  )
}

/**
 * Composes the same exact, server-fetched refund effect used by webhook
 * persistence for a claimed refund worker. It performs provider reads only;
 * all local writes remain in the caller-owned finalization transaction.
 */
export async function composeServerFetchedRefundEffect(input: {
  inboxEventId: string
  providerMode: ProviderMode
  refund: RazorpayRefundDto
  adapter: RazorpayServerAdapter
  store?: WebhookDomainMappingStore
}): Promise<RefundEffectInput> {
  const { refund, adapter } = input
  if (
    adapter.providerMode !== input.providerMode ||
    refund.providerMode !== input.providerMode
  ) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      'Refund worker provider mode is inconsistent',
    )
  }
  const payment = await fetchProviderEntity(() =>
    adapter.fetchPayment(refund.paymentId))
  assertPaymentReferences({
    providerMode: input.providerMode,
    razorpayPaymentId: refund.paymentId,
  }, payment)
  assertFinancialEntity({
    kind: 'refund',
    providerMode: input.providerMode,
    expectedId: refund.id,
    expectedPaymentId: refund.paymentId,
    entity: refund,
  })
  const target = await resolvePaymentTarget({
    adapter,
    store: input.store ?? mongoWebhookDomainMappingStore,
    payment,
  })
  const eventType: RefundWebhookReferences['eventType'] =
    refund.status === 'processed'
      ? 'refund.processed'
      : refund.status === 'failed'
        ? 'refund.failed'
        : 'refund.created'
  return Object.freeze({
    inboxEventId: input.inboxEventId,
    providerMode: input.providerMode,
    eventType,
    razorpayRefundId: refund.id,
    razorpayPaymentId: refund.paymentId,
    refund,
    payment,
    target,
  })
}

async function dispatchOrderPaid(input: {
  references: Extract<
    NormalizedRazorpayWebhookReferences,
    { eventType: 'order.paid' }
  >
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  persist: PersistOneTimeWebhookCapture
  capturedCheckoutDependencies?:
    PersistServerFetchedCapturedCheckoutDependencies
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store } = input
  const [order, payment] = await Promise.all([
    fetchProviderEntity(() => adapter.fetchOrder(
      references.razorpayOrderId,
    )),
    fetchProviderEntity(() => adapter.fetchPayment(
      references.razorpayPaymentId,
    )),
  ])
  assertOrderIdentity(
    references.providerMode,
    references.razorpayOrderId,
    order,
  )
  assertPaymentReferences(references, payment)
  assertPaidOneTimeOrder(order)
  if (payment.subscriptionId) {
    const target = await resolvePaymentTarget({
      adapter,
      store,
      payment,
    })
    if (target.kind !== 'subscription') {
      throw failure(
        'local_mapping_mismatch',
        'review',
        'Subscription-linked paid order resolved to a one-time checkout',
      )
    }
    return {
      outcome: 'ignored_safe',
      reason: 'subscription_charged_is_authoritative',
      eventType: 'order.paid',
      providerMode: references.providerMode,
      razorpayPaymentId: payment.id,
      razorpaySubscriptionId: target.subscription.id,
    }
  }
  const intent = await loadLocalMapping(() => (
    store.loadOneTimeIntentByOrder({
      providerMode: references.providerMode,
      razorpayOrderId: references.razorpayOrderId,
    })
  ))
  if (!intent) {
    throw failure(
      'local_mapping_missing',
      'retry',
      'Verified paid order has no one-time checkout correlation',
    )
  }
  assertOneTimeOrderMapping({ intent, order, payment })
  return persistOneTimeCapture({
    eventType: 'order.paid',
    intent,
    order,
    payment,
    persist: input.persist,
    capturedCheckoutDependencies: input.capturedCheckoutDependencies,
  })
}

async function dispatchPaymentEvent(input: {
  references: PaymentWebhookReferences
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  effects: WebhookDomainEffectHandlers
  persist: PersistOneTimeWebhookCapture
  capturedCheckoutDependencies?:
    PersistServerFetchedCapturedCheckoutDependencies
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store, effects } = input
  const payment = await fetchProviderEntity(() => (
    adapter.fetchPayment(references.razorpayPaymentId)
  ))
  assertPaymentReferences(references, payment)
  const target = await resolvePaymentTarget({ adapter, store, payment })

  const checkout = target.kind === 'subscription'
    ? target.context.checkout
    : undefined
  if (
    target.kind === 'subscription' &&
    payment.invoiceId === undefined &&
    (
      checkout?.purpose === 'replacement' ||
      checkout?.purpose === 'resubscribe'
    )
  ) {
    const acknowledgement = await invokeEffect(
      'future_subscription_authorization',
      effects.handleFutureSubscriptionAuthorization,
      {
        inboxEventId: references.inboxEventId,
        providerMode: references.providerMode,
        eventType: references.eventType,
        razorpayPaymentId: payment.id,
        razorpaySubscriptionId: target.subscription.id,
        payment,
        target,
      },
    )
    return {
      outcome: 'effect_handled',
      effect: 'future_subscription_authorization',
      eventType: references.eventType,
      providerMode: references.providerMode,
      operationKey: acknowledgement.operationKey,
    }
  }

  if (payment.status === 'captured' && payment.captured === true) {
    if (target.kind === 'one_time_checkout') {
      return persistOneTimeCapture({
        eventType: 'payment.captured',
        intent: target.intent,
        order: target.order,
        payment,
        persist: input.persist,
        capturedCheckoutDependencies: input.capturedCheckoutDependencies,
      })
    }
    return {
      outcome: 'ignored_safe',
      reason: 'subscription_charged_is_authoritative',
      eventType: 'payment.captured',
      providerMode: references.providerMode,
      razorpayPaymentId: payment.id,
      razorpaySubscriptionId: target.subscription.id,
    }
  }

  if (references.eventType === 'payment.captured') {
    throw failure(
      'provider_state_not_ready',
      payment.status === 'created' || payment.status === 'authorized'
        ? 'retry'
        : 'review',
      'Payment capture webhook is not backed by a captured provider payment',
    )
  }

  const acknowledgement = await invokeEffect(
    'payment_state',
    effects.handlePaymentState,
    {
      inboxEventId: references.inboxEventId,
      providerMode: references.providerMode,
      eventType: references.eventType,
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
      payment,
      target,
    },
  )
  return {
    outcome: 'effect_handled',
    effect: 'payment_state',
    eventType: references.eventType,
    providerMode: references.providerMode,
    operationKey: acknowledgement.operationKey,
  }
}

async function dispatchSubscriptionCharged(input: {
  references: SubscriptionChargedWebhookReferences
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  effects: WebhookDomainEffectHandlers
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store, effects } = input
  const payment = await fetchProviderEntity(() => adapter.fetchPayment(
    references.razorpayPaymentId,
  ))
  assertPaymentReferences(references, payment)
  if (payment.subscriptionId !== references.razorpaySubscriptionId) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      'Fetched charged payment does not belong to the subscription',
    )
  }
  if (!payment.invoiceId) {
    throw failure(
      'provider_state_not_ready',
      'retry',
      'Subscription charge payment does not yet reference an invoice',
    )
  }
  if (
    payment.status !== 'captured' ||
    payment.captured !== true ||
    payment.amountRefundedPaise !== 0 ||
    payment.currency !== 'INR'
  ) {
    throw failure(
      'provider_state_not_ready',
      payment.status === 'created' || payment.status === 'authorized'
        ? 'retry'
        : 'review',
      'Subscription charge is not backed by an unreversed capture',
    )
  }
  const [subscription, invoice] = await Promise.all([
    fetchProviderEntity(() => adapter.fetchSubscription(
      references.razorpaySubscriptionId,
    )),
    fetchProviderEntity(() => adapter.fetchInvoice(
      payment.invoiceId as string,
    )),
  ])
  assertSubscriptionIdentity(
    references.providerMode,
    references.razorpaySubscriptionId,
    subscription,
  )
  assertPaidSubscriptionInvoice({
    providerMode: references.providerMode,
    razorpaySubscriptionId: references.razorpaySubscriptionId,
    payment: payment as RazorpayPaymentDto & { invoiceId: string },
    invoice,
  })
  const localContext = await loadAndAssertSubscriptionContext({
    store,
    providerMode: references.providerMode,
    razorpaySubscriptionId: references.razorpaySubscriptionId,
    remote: subscription,
  })

  // Deliberately do not load or compare the initial subscription intent's
  // payable amount. A recurring cycle has its own provider invoice/payment
  // consideration and must be persisted by the injected cycle service.
  const acknowledgement = await invokeEffect(
    'subscription_charged',
    effects.handleSubscriptionCharged,
    {
      inboxEventId: references.inboxEventId,
      providerMode: references.providerMode,
      eventType: 'subscription.charged',
      razorpaySubscriptionId: references.razorpaySubscriptionId,
      razorpayPaymentId: references.razorpayPaymentId,
      razorpayInvoiceId: payment.invoiceId,
      ...(references.razorpayOrderId
        ? { razorpayOrderId: references.razorpayOrderId }
        : {}),
      subscription,
      payment,
      invoice,
      localContext,
    },
  )
  return {
    outcome: 'effect_handled',
    effect: 'subscription_charged',
    eventType: references.eventType,
    providerMode: references.providerMode,
    operationKey: acknowledgement.operationKey,
  }
}

async function dispatchSubscriptionState(input: {
  references: SubscriptionStateWebhookReferences
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  effects: WebhookDomainEffectHandlers
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store, effects } = input
  const [subscription, payment] = await Promise.all([
    fetchProviderEntity(() => adapter.fetchSubscription(
      references.razorpaySubscriptionId,
    )),
    references.razorpayPaymentId
      ? fetchProviderEntity(() => adapter.fetchPayment(
          references.razorpayPaymentId as string,
        ))
      : Promise.resolve(undefined),
  ])
  const providerObservedAt = new Date()
  if (!Number.isFinite(providerObservedAt.getTime())) {
    throw failure(
      'provider_state_not_ready',
      'retry',
      'Provider subscription observation clock is invalid',
    )
  }
  assertSubscriptionIdentity(
    references.providerMode,
    references.razorpaySubscriptionId,
    subscription,
  )
  if (payment) {
    assertPaymentReferences(
      references as SubscriptionStateWebhookReferences & {
        razorpayPaymentId: string
      },
      payment,
    )
    if (payment.subscriptionId !== references.razorpaySubscriptionId) {
      throw failure(
        'provider_reference_mismatch',
        'review',
        'Fetched state-event payment does not belong to the subscription',
      )
    }
  }
  const localContext = await loadAndAssertSubscriptionContext({
    store,
    providerMode: references.providerMode,
    razorpaySubscriptionId: references.razorpaySubscriptionId,
    remote: subscription,
  })
  const acknowledgement = await invokeEffect(
    'subscription_state',
    effects.handleSubscriptionState,
    {
      inboxEventId: references.inboxEventId,
      providerMode: references.providerMode,
      eventType: references.eventType,
      providerObservedAt,
      razorpaySubscriptionId: references.razorpaySubscriptionId,
      ...(references.razorpayPaymentId
        ? { razorpayPaymentId: references.razorpayPaymentId }
        : {}),
      ...(references.razorpayInvoiceId
        ? { razorpayInvoiceId: references.razorpayInvoiceId }
        : {}),
      ...(references.razorpayOrderId
        ? { razorpayOrderId: references.razorpayOrderId }
        : {}),
      subscription,
      ...(payment ? { payment } : {}),
      localContext,
    },
  )
  return {
    outcome: 'effect_handled',
    effect: 'subscription_state',
    eventType: references.eventType,
    providerMode: references.providerMode,
    operationKey: acknowledgement.operationKey,
  }
}

function assertFinancialEntity(input: {
  kind: 'refund' | 'dispute'
  providerMode: ProviderMode
  expectedId: string
  expectedPaymentId: string
  entity: RazorpayWebhookRefundDto | RazorpayWebhookDisputeDto
}): void {
  if (input.entity.providerMode !== input.providerMode) {
    throw failure(
      'provider_mode_mismatch',
      'review',
      `Fetched ${input.kind} mode does not match the verified webhook mode`,
    )
  }
  if (
    input.entity.id !== input.expectedId ||
    input.entity.paymentId !== input.expectedPaymentId ||
    input.entity.currency !== 'INR' ||
    !Number.isSafeInteger(input.entity.amountPaise) ||
    input.entity.amountPaise < 0 ||
    typeof input.entity.status !== 'string' ||
    input.entity.status.trim().length === 0
  ) {
    throw failure(
      'provider_reference_mismatch',
      'review',
      `Fetched ${input.kind} does not match the verified webhook`,
    )
  }
}

async function dispatchRefund(input: {
  references: RefundWebhookReferences
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  effects: WebhookDomainEffectHandlers
  reader?: RazorpayWebhookFinancialEntityReader
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store, effects, reader } = input
  const [payment, refund] = await Promise.all([
    fetchProviderEntity(() => adapter.fetchPayment(
      references.razorpayPaymentId,
    )),
    fetchProviderEntity(() => (
      reader
        ? reader.fetchRefund({
            providerMode: references.providerMode,
            razorpayRefundId: references.razorpayRefundId,
          })
        : adapter.fetchRefund(references.razorpayRefundId)
    )),
  ])
  assertPaymentReferences(references, payment)
  assertFinancialEntity({
    kind: 'refund',
    providerMode: references.providerMode,
    expectedId: references.razorpayRefundId,
    expectedPaymentId: references.razorpayPaymentId,
    entity: refund,
  })
  const target = await resolvePaymentTarget({ adapter, store, payment })
  const acknowledgement = await invokeEffect(
    'refund',
    effects.handleRefund,
    {
      inboxEventId: references.inboxEventId,
      providerMode: references.providerMode,
      eventType: references.eventType,
      razorpayRefundId: references.razorpayRefundId,
      razorpayPaymentId: references.razorpayPaymentId,
      refund,
      payment,
      target,
    },
  )
  return {
    outcome: 'effect_handled',
    effect: 'refund',
    eventType: references.eventType,
    providerMode: references.providerMode,
    operationKey: acknowledgement.operationKey,
  }
}

async function dispatchDispute(input: {
  references: DisputeWebhookReferences
  adapter: RazorpayServerAdapter
  store: WebhookDomainMappingStore
  effects: WebhookDomainEffectHandlers
  reader?: RazorpayWebhookFinancialEntityReader
}): Promise<WebhookDomainDispatchResult> {
  const { references, adapter, store, effects, reader } = input
  const [payment, dispute] = await Promise.all([
    fetchProviderEntity(() => adapter.fetchPayment(
      references.razorpayPaymentId,
    )),
    fetchProviderEntity(() => (
      reader
        ? reader.fetchDispute({
            providerMode: references.providerMode,
            razorpayDisputeId: references.razorpayDisputeId,
          })
        : adapter.fetchDispute(references.razorpayDisputeId)
    )),
  ])
  assertPaymentReferences(references, payment)
  assertFinancialEntity({
    kind: 'dispute',
    providerMode: references.providerMode,
    expectedId: references.razorpayDisputeId,
    expectedPaymentId: references.razorpayPaymentId,
    entity: dispute,
  })
  const target = await resolvePaymentTarget({ adapter, store, payment })
  const acknowledgement = await invokeEffect(
    'dispute',
    effects.handleDispute,
    {
      inboxEventId: references.inboxEventId,
      providerMode: references.providerMode,
      eventType: references.eventType,
      razorpayDisputeId: references.razorpayDisputeId,
      razorpayPaymentId: references.razorpayPaymentId,
      dispute,
      payment,
      target,
    },
  )
  return {
    outcome: 'effect_handled',
    effect: 'dispute',
    eventType: references.eventType,
    providerMode: references.providerMode,
    operationKey: acknowledgement.operationKey,
  }
}

/**
 * Dispatches only envelopes produced by the signature-verified durable inbox
 * processor. Every successful path either persists a one-time capture, obtains
 * an explicit durable effect acknowledgement, or applies the documented
 * safe-ignore policy to subscription-linked order/payment capture signals
 * (`subscription.charged` remains the paid-cycle authority). Missing mappings
 * and handlers fail closed.
 */
export async function dispatchVerifiedRazorpayWebhook(
  envelope: VerifiedPaymentWebhookEnvelope,
  dependencies: WebhookDomainDispatchDependencies = {},
): Promise<WebhookDomainDispatchResult> {
  let references: NormalizedRazorpayWebhookReferences
  try {
    references = parseVerifiedWebhookReferences(envelope)
  } catch (error) {
    if (error instanceof WebhookReferenceParseError) {
      throw failure(
        'references_invalid',
        'review',
        'Verified Razorpay webhook references are invalid',
        error,
      )
    }
    throw error
  }

  const clientFactory = dependencies.clientFactory ?? defaultClientFactory
  const store = dependencies.store ?? mongoWebhookDomainMappingStore
  const effects = dependencies.effects ?? {}
  const persist =
    dependencies.persistOneTimeCapture ??
    persistServerFetchedCapturedCheckout
  const adapter = adapterForMode(references.providerMode, clientFactory)

  switch (references.kind) {
    case 'order':
      return dispatchOrderPaid({
        references,
        adapter,
        store,
        persist,
        capturedCheckoutDependencies:
          dependencies.capturedCheckoutDependencies,
      })
    case 'payment':
      return dispatchPaymentEvent({
        references,
        adapter,
        store,
        effects,
        persist,
        capturedCheckoutDependencies:
          dependencies.capturedCheckoutDependencies,
      })
    case 'subscription':
      return references.eventType === 'subscription.charged'
        ? dispatchSubscriptionCharged({
            references,
            adapter,
            store,
            effects,
          })
        : dispatchSubscriptionState({
            references,
            adapter,
            store,
            effects,
          })
    case 'refund':
      return dispatchRefund({
        references,
        adapter,
        store,
        effects,
        reader: dependencies.financialEntityReader,
      })
    case 'dispute':
      return dispatchDispute({
        references,
        adapter,
        store,
        effects,
        reader: dependencies.financialEntityReader,
      })
  }
}

/**
 * Adapter for processPaymentWebhookEvent. It intentionally returns void only
 * after dispatchVerifiedRazorpayWebhook has produced a non-no-op outcome.
 */
export function createRazorpayWebhookDomainHandler(
  dependencies: WebhookDomainDispatchDependencies = {},
): PaymentWebhookHandler {
  return async (envelope) => {
    await dispatchVerifiedRazorpayWebhook(envelope, dependencies)
  }
}
