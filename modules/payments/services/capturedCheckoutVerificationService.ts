import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  ChargeFulfillment,
  type ChargeFulfillmentKind,
  type ChargeFulfillmentStatus,
  type IChargeFulfillmentSteps,
} from '../models/ChargeFulfillment'
import {
  CheckoutIntent,
  type CheckoutIntentKind,
  type CheckoutIntentPurpose,
  type CheckoutIntentStatus,
} from '../models/CheckoutIntent'
import { PaymentAttempt } from '../models/PaymentAttempt'
import {
  createRazorpayClientFactory,
  type RazorpayClientFactory,
} from '../providers/razorpayClientFactory'
import {
  loadRazorpayApiCredentials,
  type RazorpayApiCredentials,
} from '../providers/razorpayEnvironment'
import type {
  RazorpayPaymentDto,
} from '../providers/razorpayServerAdapter'
import {
  verifyRazorpayOrderCheckoutSignature,
  verifyRazorpaySubscriptionCheckoutSignature,
} from '../providers/razorpaySignature'
import type { ProviderMode } from '../types/catalog'

export const CAPTURED_CHECKOUT_EXPECTED_KINDS = [
  'order',
  'subscription',
] as const
export type CapturedCheckoutExpectedKind =
  (typeof CAPTURED_CHECKOUT_EXPECTED_KINDS)[number]

export const CAPTURED_CHECKOUT_VERIFICATION_ERROR_CODES = [
  'invalid_request',
  'intent_not_found',
  'intent_kind_mismatch',
  'intent_mode_mismatch',
  'intent_state_invalid',
  'trusted_remote_id_missing',
  'signature_invalid',
  'provider_unavailable',
  'payment_identity_mismatch',
  'payment_capture_pending',
  'payment_failed',
  'payment_reversed',
  'payment_not_captured',
  'payment_currency_mismatch',
  'payment_amount_mismatch',
  'payment_reference_mismatch',
  'persistence_conflict',
] as const
export type CapturedCheckoutVerificationErrorCode =
  (typeof CAPTURED_CHECKOUT_VERIFICATION_ERROR_CODES)[number]

export class CapturedCheckoutVerificationError extends Error {
  readonly code: CapturedCheckoutVerificationErrorCode

  constructor(
    code: CapturedCheckoutVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CapturedCheckoutVerificationError'
    this.code = code
  }
}

export interface CapturedCheckoutVerificationInput {
  userId: string
  intentId: string
  razorpayPaymentId: string
  signature: string
  expectedKind: CapturedCheckoutExpectedKind
}

export interface CapturedCommercialAnalyticsEvidence {
  readonly sourceEvidenceId: string
  readonly correlationId: string
  readonly subjectId: string
  readonly providerMode: ProviderMode
  readonly occurredAt: Date
  readonly checkoutKind: CheckoutIntentKind
  readonly productKey: 'plus' | 'pro' | 'single_interview' | 'premium_resume' | null
  readonly catalogVersion: string | null
  readonly listPricePaise: number | null
  readonly discountPaise: number | null
  readonly payablePaise: number
  readonly renewalPricePaise: number | null
  readonly couponCampaignId: string | null
}

export interface CapturedCommercialAnalyticsProducer {
  appendCapturedInSession(
    evidence: () => CapturedCommercialAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface TrustedCheckoutIntentForCapture {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  purpose?: CheckoutIntentPurpose
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  payablePaise: number
  currency: 'INR'
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

export interface NormalizedCapturedPaymentSnapshot {
  providerMode: ProviderMode
  id: string
  orderId?: string
  subscriptionId?: string
  invoiceId?: string
  amountPaise: number
  amountRefundedPaise: number
  currency: 'INR'
  status: 'captured'
  captured: true
  createdAtEpochSeconds: number
}

export interface CapturedPaymentAttemptDraft {
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: 'captured'
  amountPaise: number
  currency: 'INR'
  providerSnapshot: NormalizedCapturedPaymentSnapshot
  lastSyncedAt: Date
}

export interface VerifiedChargeFulfillmentDraft {
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  userId: mongoose.Types.ObjectId
  kind: ChargeFulfillmentKind
  status: 'verified'
  verifiedAmountPaise: number
  verifiedCurrency: 'INR'
  steps: IChargeFulfillmentSteps
  attempts: 0
}

export interface PersistVerifiedCaptureInput {
  intent: TrustedCheckoutIntentForCapture
  paymentAttempt: CapturedPaymentAttemptDraft
  fulfillment: VerifiedChargeFulfillmentDraft
}

export interface PersistVerifiedCaptureResult {
  intentStatus: 'payment_captured' | 'fulfilled'
  fulfillmentId: string
  fulfillmentStatus: ChargeFulfillmentStatus
  reused: boolean
}

export interface CapturedCheckoutVerificationStore {
  loadIntentForUser(input: {
    intentId: mongoose.Types.ObjectId
    userId: mongoose.Types.ObjectId
  }): Promise<TrustedCheckoutIntentForCapture | null>
  persistVerifiedCapture(
    input: PersistVerifiedCaptureInput,
    producer?: CapturedCommercialAnalyticsProducer,
  ): Promise<PersistVerifiedCaptureResult>
}

export interface CapturedCheckoutVerificationDependencies {
  store?: CapturedCheckoutVerificationStore
  clientFactory?: RazorpayClientFactory
  loadCredentials?: (
    mode: ProviderMode,
  ) => RazorpayApiCredentials
  now?: () => Date
  commercialAnalyticsProducer?: CapturedCommercialAnalyticsProducer
}

export interface CapturedCheckoutVerificationResult
  extends PersistVerifiedCaptureResult {
  intentId: string
  providerMode: ProviderMode
  razorpayPaymentId: string
  checkoutKind: CapturedCheckoutExpectedKind
  fulfillmentKind: ChargeFulfillmentKind
}

export interface PersistServerFetchedCapturedCheckoutInput {
  intent: TrustedCheckoutIntentForCapture
  payment: RazorpayPaymentDto
  requestedPaymentId: string
  expectedKind: CapturedCheckoutExpectedKind
}

export interface PersistServerFetchedCapturedCheckoutDependencies {
  store?: CapturedCheckoutVerificationStore
  now?: () => Date
  commercialAnalyticsProducer?: CapturedCommercialAnalyticsProducer
}

interface StoredPaymentAttempt {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: string
  amountPaise: number
  currency: string
}

interface StoredChargeFulfillment {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  userId: mongoose.Types.ObjectId
  kind: ChargeFulfillmentKind
  status: ChargeFulfillmentStatus
  verifiedAmountPaise: number
  verifiedCurrency: string
  steps: IChargeFulfillmentSteps
}

const PRE_CAPTURE_INTENT_STATUSES: readonly CheckoutIntentStatus[] = [
  'remote_created',
  'checkout_opened',
  'authorization_pending',
]
const DUPLICATE_INTENT_STATUSES: readonly CheckoutIntentStatus[] = [
  'payment_captured',
  'fulfilled',
]
const COHERENT_FULFILLMENT_STATUSES: readonly ChargeFulfillmentStatus[] = [
  'verified',
  'entitlement_applied',
  'invoiced',
  'notified',
  'done',
]

const defaultRazorpayClientFactory = createRazorpayClientFactory()

function failure(
  code: CapturedCheckoutVerificationErrorCode,
  message: string,
  cause?: unknown,
): CapturedCheckoutVerificationError {
  return new CapturedCheckoutVerificationError(
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

function assertCanonicalPaymentId(value: string): void {
  if (!/^pay_[A-Za-z0-9]+$/.test(value) || value.length > 128) {
    throw failure(
      'invalid_request',
      'razorpayPaymentId must be a canonical Razorpay payment id',
    )
  }
}

function assertExpectedKind(value: string): asserts value is
  CapturedCheckoutExpectedKind {
  if (
    !CAPTURED_CHECKOUT_EXPECTED_KINDS.includes(
      value as CapturedCheckoutExpectedKind,
    )
  ) {
    throw failure('invalid_request', 'Unsupported checkout verification kind')
  }
}

function expectedKindForIntent(
  kind: CheckoutIntentKind,
): CapturedCheckoutExpectedKind {
  return kind === 'subscription' ? 'subscription' : 'order'
}

function fulfillmentKindForIntent(
  kind: CheckoutIntentKind,
): ChargeFulfillmentKind {
  return kind === 'subscription' ? 'subscription_cycle' : kind
}

function assertIntentCanVerify(
  intent: TrustedCheckoutIntentForCapture,
  expectedKind: CapturedCheckoutExpectedKind,
): void {
  if (expectedKindForIntent(intent.kind) !== expectedKind) {
    throw failure(
      'intent_kind_mismatch',
      'Checkout intent does not match the expected payment flow',
    )
  }
  if (
    expectedKind === 'subscription' &&
    intent.purpose !== 'acquisition'
  ) {
    throw failure(
      'intent_kind_mismatch',
      'Future subscription authorization requires lifecycle verification',
    )
  }
  if (
    !PRE_CAPTURE_INTENT_STATUSES.includes(intent.status) &&
    !DUPLICATE_INTENT_STATUSES.includes(intent.status)
  ) {
    throw failure(
      'intent_state_invalid',
      'Checkout intent is not in a verifiable state',
    )
  }
  if (
    !Number.isSafeInteger(intent.payablePaise) ||
    intent.payablePaise < 0 ||
    intent.currency !== 'INR'
  ) {
    throw failure(
      'persistence_conflict',
      'Checkout intent has an invalid commercial snapshot',
    )
  }

  const trustedRemoteId = expectedKind === 'order'
    ? intent.razorpayOrderId
    : intent.razorpaySubscriptionId
  if (!trustedRemoteId) {
    throw failure(
      'trusted_remote_id_missing',
      'Checkout intent is missing its trusted provider identifier',
    )
  }
}

function verifyCheckoutSignature(input: {
  intent: TrustedCheckoutIntentForCapture
  expectedKind: CapturedCheckoutExpectedKind
  razorpayPaymentId: string
  signature: string
  keySecret: string
}): boolean {
  if (input.expectedKind === 'order') {
    return verifyRazorpayOrderCheckoutSignature({
      trustedOrderId: input.intent.razorpayOrderId as string,
      razorpayPaymentId: input.razorpayPaymentId,
      signature: input.signature,
      keySecret: input.keySecret,
    })
  }
  return verifyRazorpaySubscriptionCheckoutSignature({
    razorpayPaymentId: input.razorpayPaymentId,
    trustedSubscriptionId: input.intent.razorpaySubscriptionId as string,
    signature: input.signature,
    keySecret: input.keySecret,
  })
}

type CapturedRazorpayPaymentDto = RazorpayPaymentDto & {
  status: 'captured'
  captured: true
}

function requireCapturedPayment(input: {
  payment: RazorpayPaymentDto
  intent: TrustedCheckoutIntentForCapture
  expectedKind: CapturedCheckoutExpectedKind
  requestedPaymentId: string
}): CapturedRazorpayPaymentDto {
  const { payment, intent, expectedKind, requestedPaymentId } = input
  if (payment.providerMode !== intent.providerMode) {
    throw failure(
      'intent_mode_mismatch',
      'Provider payment mode does not match the checkout intent',
    )
  }
  if (payment.id !== requestedPaymentId) {
    throw failure(
      'payment_identity_mismatch',
      'Provider returned a different payment identifier',
    )
  }
  if (
    (payment.status === 'created' || payment.status === 'authorized') &&
    payment.captured === false &&
    payment.amountRefundedPaise === 0
  ) {
    throw failure(
      'payment_capture_pending',
      'Payment has not been captured yet',
    )
  }
  if (payment.status === 'failed') {
    throw failure('payment_failed', 'Payment failed before capture')
  }
  if (
    payment.status === 'refunded' ||
    payment.amountRefundedPaise !== 0
  ) {
    throw failure(
      'payment_reversed',
      'Payment was fully or partially reversed',
    )
  }
  if (payment.status !== 'captured' || payment.captured !== true) {
    throw failure(
      'payment_not_captured',
      'Payment capture state is inconsistent',
    )
  }
  if (payment.currency !== 'INR' || payment.currency !== intent.currency) {
    throw failure(
      'payment_currency_mismatch',
      'Payment currency does not match the trusted quote',
    )
  }
  if (payment.amountPaise !== intent.payablePaise) {
    throw failure(
      'payment_amount_mismatch',
      'Payment amount does not match the trusted quote',
    )
  }

  if (expectedKind === 'order') {
    if (
      payment.orderId !== intent.razorpayOrderId ||
      payment.subscriptionId !== undefined
    ) {
      throw failure(
        'payment_reference_mismatch',
        'Payment does not belong to the trusted order',
      )
    }
  } else if (payment.subscriptionId !== intent.razorpaySubscriptionId) {
    throw failure(
      'payment_reference_mismatch',
      'Payment does not belong to the trusted subscription',
    )
  }
  return payment as CapturedRazorpayPaymentDto
}

function normalizedCapturedPayment(
  payment: CapturedRazorpayPaymentDto,
): NormalizedCapturedPaymentSnapshot {
  return {
    providerMode: payment.providerMode,
    id: payment.id,
    ...(payment.orderId ? { orderId: payment.orderId } : {}),
    ...(payment.subscriptionId
      ? { subscriptionId: payment.subscriptionId }
      : {}),
    ...(payment.invoiceId ? { invoiceId: payment.invoiceId } : {}),
    amountPaise: payment.amountPaise,
    amountRefundedPaise: payment.amountRefundedPaise,
    currency: payment.currency,
    status: payment.status,
    captured: payment.captured,
    createdAtEpochSeconds: payment.createdAtEpochSeconds,
  }
}

function fulfillmentSteps(
  providerMode: ProviderMode,
  paymentId: string,
  verifiedAt: Date,
): IChargeFulfillmentSteps {
  const operationPrefix = `${providerMode}:${paymentId}`
  return {
    verification: {
      status: 'complete',
      operationKey: `${operationPrefix}:verification`,
      completedAt: verifiedAt,
      referenceId: paymentId,
      lastAttemptAt: verifiedAt,
    },
    entitlement: {
      status: 'pending',
      operationKey: `${operationPrefix}:entitlement`,
    },
    invoice: {
      status: 'pending',
      operationKey: `${operationPrefix}:invoice`,
    },
    notification: {
      status: 'pending',
      operationKey: `${operationPrefix}:notification`,
    },
  }
}

function persistenceInput(input: {
  intent: TrustedCheckoutIntentForCapture
  payment: CapturedRazorpayPaymentDto
  verifiedAt: Date
}): PersistVerifiedCaptureInput {
  const { intent, payment, verifiedAt } = input
  const providerSnapshot = normalizedCapturedPayment(payment)
  const sharedProviderReferences = {
    ...(payment.orderId ? { razorpayOrderId: payment.orderId } : {}),
    ...(payment.subscriptionId
      ? { razorpaySubscriptionId: payment.subscriptionId }
      : {}),
    ...(payment.invoiceId ? { razorpayInvoiceId: payment.invoiceId } : {}),
  }
  return {
    intent,
    paymentAttempt: {
      providerMode: intent.providerMode,
      checkoutIntentId: intent._id,
      razorpayPaymentId: payment.id,
      ...sharedProviderReferences,
      userId: intent.userId,
      status: 'captured',
      amountPaise: payment.amountPaise,
      currency: 'INR',
      providerSnapshot,
      lastSyncedAt: verifiedAt,
    },
    fulfillment: {
      providerMode: intent.providerMode,
      razorpayPaymentId: payment.id,
      ...sharedProviderReferences,
      userId: intent.userId,
      kind: fulfillmentKindForIntent(intent.kind),
      status: 'verified',
      verifiedAmountPaise: payment.amountPaise,
      verifiedCurrency: 'INR',
      steps: fulfillmentSteps(
        intent.providerMode,
        payment.id,
        verifiedAt,
      ),
      attempts: 0,
    },
  }
}

function sameObjectId(
  left: mongoose.Types.ObjectId,
  right: mongoose.Types.ObjectId,
): boolean {
  return left.equals(right)
}

function sameOptionalString(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right
}

function commercialCaptureChanged(
  current: TrustedCheckoutIntentForCapture,
  expected: TrustedCheckoutIntentForCapture,
): boolean {
  const right =
    (expected as Partial<TransactionalCaptureIntent>).commercialCapture
  return right !== undefined &&
    JSON.stringify(
      (current as Partial<TransactionalCaptureIntent>).commercialCapture,
    ) !== JSON.stringify(right)
}

function assertAttemptCoherent(
  stored: StoredPaymentAttempt,
  draft: CapturedPaymentAttemptDraft,
): void {
  if (
    stored.providerMode !== draft.providerMode ||
    !sameObjectId(stored.checkoutIntentId, draft.checkoutIntentId) ||
    stored.razorpayPaymentId !== draft.razorpayPaymentId ||
    !sameObjectId(stored.userId, draft.userId) ||
    stored.amountPaise !== draft.amountPaise ||
    stored.currency !== draft.currency ||
    !sameOptionalString(stored.razorpayOrderId, draft.razorpayOrderId) ||
    !sameOptionalString(
      stored.razorpaySubscriptionId,
      draft.razorpaySubscriptionId,
    ) ||
    !sameOptionalString(stored.razorpayInvoiceId, draft.razorpayInvoiceId)
  ) {
    throw failure(
      'persistence_conflict',
      'Existing payment attempt conflicts with verified payment',
    )
  }
  if (!['created', 'authorized', 'captured'].includes(stored.status)) {
    throw failure(
      'persistence_conflict',
      'Existing payment attempt is not capture-compatible',
    )
  }
}

function assertFulfillmentCoherent(
  stored: StoredChargeFulfillment,
  draft: VerifiedChargeFulfillmentDraft,
): void {
  if (
    stored.providerMode !== draft.providerMode ||
    stored.razorpayPaymentId !== draft.razorpayPaymentId ||
    !sameObjectId(stored.userId, draft.userId) ||
    stored.kind !== draft.kind ||
    stored.verifiedAmountPaise !== draft.verifiedAmountPaise ||
    stored.verifiedCurrency !== draft.verifiedCurrency ||
    !sameOptionalString(stored.razorpayOrderId, draft.razorpayOrderId) ||
    !sameOptionalString(
      stored.razorpaySubscriptionId,
      draft.razorpaySubscriptionId,
    ) ||
    !sameOptionalString(stored.razorpayInvoiceId, draft.razorpayInvoiceId)
  ) {
    throw failure(
      'persistence_conflict',
      'Existing fulfillment conflicts with verified payment',
    )
  }
  if (
    stored.status !== 'received' &&
    !COHERENT_FULFILLMENT_STATUSES.includes(stored.status)
  ) {
    throw failure(
      'persistence_conflict',
      'Existing fulfillment is not verification-compatible',
    )
  }
}

function assertTransactionalIntentCoherent(
  current: TrustedCheckoutIntentForCapture | null,
  expected: TrustedCheckoutIntentForCapture,
): asserts current is TrustedCheckoutIntentForCapture {
  if (
    !current ||
    !sameObjectId(current.userId, expected.userId) ||
    current.kind !== expected.kind ||
    current.purpose !== expected.purpose ||
    current.providerMode !== expected.providerMode ||
    current.payablePaise !== expected.payablePaise ||
    current.currency !== expected.currency ||
    current.razorpayOrderId !== expected.razorpayOrderId ||
    current.razorpaySubscriptionId !== expected.razorpaySubscriptionId ||
    commercialCaptureChanged(current, expected)
  ) {
    throw failure(
      'persistence_conflict',
      'Checkout intent changed before payment capture persisted',
    )
  }
  assertIntentCanVerify(current, expectedKindForIntent(expected.kind))
}

interface LeanMongoCaptureIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  purpose?: CheckoutIntentPurpose
  providerMode: ProviderMode
  status: CheckoutIntentStatus
  planKey?: 'plus' | 'pro'
  sku?: 'single_interview' | 'premium_resume'
  catalogVersion?: string
  quoteSnapshot: {
    listPricePaise?: number
    discountPaise?: number
    payablePaise: number
    renewalPricePaise?: number
    currency: 'INR'
    couponCampaignId?: mongoose.Types.ObjectId
  }
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

type TransactionalCommercialCapture = Pick<
  CapturedCommercialAnalyticsEvidence,
  'checkoutKind' | 'productKey' | 'catalogVersion'
  | 'listPricePaise' | 'discountPaise' | 'payablePaise'
  | 'renewalPricePaise' | 'couponCampaignId'
>

interface TransactionalCaptureIntent
  extends TrustedCheckoutIntentForCapture {
  commercialCapture: TransactionalCommercialCapture
}

async function loadMongoIntent(
  intentId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  session?: ClientSession,
): Promise<TransactionalCaptureIntent | null> {
  const query = CheckoutIntent.findOne({
    _id: intentId,
    userId,
  }).select({
    _id: 1,
    userId: 1,
    kind: 1,
    purpose: 1,
    providerMode: 1,
    status: 1,
    planKey: 1,
    sku: 1,
    catalogVersion: 1,
    'quoteSnapshot.listPricePaise': 1,
    'quoteSnapshot.discountPaise': 1,
    'quoteSnapshot.payablePaise': 1,
    'quoteSnapshot.renewalPricePaise': 1,
    'quoteSnapshot.currency': 1,
    'quoteSnapshot.couponCampaignId': 1,
    razorpayOrderId: 1,
    razorpaySubscriptionId: 1,
  })
  if (session) query.session(session)
  const intent = await query.lean<LeanMongoCaptureIntent>()
  if (!intent) return null
  return {
    _id: intent._id,
    userId: intent.userId,
    kind: intent.kind,
    purpose: intent.purpose,
    providerMode: intent.providerMode,
    status: intent.status,
    payablePaise: intent.quoteSnapshot.payablePaise,
    currency: intent.quoteSnapshot.currency,
    razorpayOrderId: intent.razorpayOrderId,
    razorpaySubscriptionId: intent.razorpaySubscriptionId,
    commercialCapture: {
      checkoutKind: intent.kind,
      productKey: intent.kind === 'subscription'
        ? intent.planKey ?? null
        : intent.sku ?? null,
      catalogVersion: intent.catalogVersion ?? null,
      listPricePaise: intent.quoteSnapshot.listPricePaise ?? null,
      discountPaise: intent.quoteSnapshot.discountPaise ?? null,
      payablePaise: intent.quoteSnapshot.payablePaise,
      renewalPricePaise:
        intent.quoteSnapshot.renewalPricePaise ?? null,
      couponCampaignId:
        intent.quoteSnapshot.couponCampaignId?.toHexString() ?? null,
    },
  }
}

async function upsertCapturedAttempt(
  draft: CapturedPaymentAttemptDraft,
  session: ClientSession,
): Promise<{ attempt: StoredPaymentAttempt; reused: boolean }> {
  const key = {
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }
  const existing = await PaymentAttempt.findOne(key)
    .session(session)
    .lean<StoredPaymentAttempt>()
  const upserted = await PaymentAttempt.findOneAndUpdate(
    key,
    { $setOnInsert: draft },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      session,
    },
  ).lean<StoredPaymentAttempt>()
  if (!upserted) {
    throw failure(
      'persistence_conflict',
      'Payment attempt persistence returned no record',
    )
  }
  assertAttemptCoherent(upserted, draft)

  const captured = await PaymentAttempt.findOneAndUpdate(
    {
      ...key,
      status: { $in: ['created', 'authorized', 'captured'] },
    },
    {
      $set: {
        status: 'captured',
        providerSnapshot: draft.providerSnapshot,
        lastSyncedAt: draft.lastSyncedAt,
      },
    },
    {
      new: true,
      runValidators: true,
      session,
    },
  ).lean<StoredPaymentAttempt>()
  if (!captured) {
    throw failure(
      'persistence_conflict',
      'Payment attempt could not advance to captured',
    )
  }
  assertAttemptCoherent(captured, draft)
  return { attempt: captured, reused: existing !== null }
}

async function upsertVerifiedFulfillment(
  draft: VerifiedChargeFulfillmentDraft,
  session: ClientSession,
): Promise<{ fulfillment: StoredChargeFulfillment; reused: boolean }> {
  const key = {
    providerMode: draft.providerMode,
    razorpayPaymentId: draft.razorpayPaymentId,
  }
  const existing = await ChargeFulfillment.findOne(key)
    .session(session)
    .lean<StoredChargeFulfillment>()
  let fulfillment = await ChargeFulfillment.findOneAndUpdate(
    key,
    { $setOnInsert: draft },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      session,
    },
  ).lean<StoredChargeFulfillment>()
  if (!fulfillment) {
    throw failure(
      'persistence_conflict',
      'Charge fulfillment persistence returned no record',
    )
  }
  assertFulfillmentCoherent(fulfillment, draft)

  if (fulfillment.status === 'received') {
    const advanced = await ChargeFulfillment.findOneAndUpdate(
      { ...key, status: 'received' },
      {
        $set: {
          status: 'verified',
          'steps.verification': draft.steps.verification,
        },
      },
      {
        new: true,
        runValidators: true,
        session,
      },
    ).lean<StoredChargeFulfillment>()
    if (!advanced) {
      throw failure(
        'persistence_conflict',
        'Charge fulfillment verification raced with another writer',
      )
    }
    fulfillment = advanced
  }
  assertFulfillmentCoherent(fulfillment, draft)
  if (
    fulfillment.steps.verification.status !== 'complete' ||
    !fulfillment.steps.verification.completedAt
  ) {
    throw failure(
      'persistence_conflict',
      'Verified fulfillment lacks payment verification evidence',
    )
  }
  return { fulfillment, reused: existing !== null }
}

async function advanceIntentAfterPersistence(input: {
  current: TrustedCheckoutIntentForCapture
  expected: TrustedCheckoutIntentForCapture
  session: ClientSession
}): Promise<'payment_captured' | 'fulfilled'> {
  if (input.current.status === 'fulfilled') return 'fulfilled'
  if (input.current.status === 'payment_captured') return 'payment_captured'

  const result = await CheckoutIntent.updateOne(
    {
      _id: input.expected._id,
      userId: input.expected.userId,
      status: input.current.status,
    },
    {
      $set: { status: 'payment_captured' },
      $unset: { nextRecoveryAt: 1 },
    },
    {
      runValidators: true,
      session: input.session,
    },
  )
  if (result.modifiedCount !== 1) {
    const raced = await loadMongoIntent(
      input.expected._id,
      input.expected.userId,
      input.session,
    )
    assertTransactionalIntentCoherent(raced, input.expected)
    if (
      raced.status === 'payment_captured' ||
      raced.status === 'fulfilled'
    ) {
      return raced.status
    }
    throw failure(
      'persistence_conflict',
      'Checkout intent could not advance after verified persistence',
    )
  }
  return 'payment_captured'
}

export const mongoCapturedCheckoutVerificationStore:
CapturedCheckoutVerificationStore = {
  async loadIntentForUser(input) {
    await connectDB()
    return loadMongoIntent(input.intentId, input.userId)
  },

  async persistVerifiedCapture(input, producer) {
    await connectDB()
    const session = await mongoose.startSession()
    let result: PersistVerifiedCaptureResult | undefined
    try {
      await session.withTransaction(
        async () => {
          const current = await loadMongoIntent(
            input.intent._id,
            input.intent.userId,
            session,
          )
          assertTransactionalIntentCoherent(current, input.intent)

          const attempt = await upsertCapturedAttempt(
            input.paymentAttempt,
            session,
          )
          const fulfillment = await upsertVerifiedFulfillment(
            input.fulfillment,
            session,
          )

          // This state transition is deliberately last. A callback can never
          // advertise payment_captured before both durable ledgers exist.
          const intentStatus = await advanceIntentAfterPersistence({
            current,
            expected: input.intent,
            session,
          })
          await producer?.appendCapturedInSession(
            () => Object.freeze({
              ...current.commercialCapture,
              sourceEvidenceId: attempt.attempt._id.toHexString(),
              correlationId: current._id.toHexString(),
              subjectId: current.userId.toHexString(),
              providerMode: current.providerMode,
              occurredAt: input.paymentAttempt.lastSyncedAt,
            }),
            session,
          )
          result = {
            intentStatus,
            fulfillmentId: fulfillment.fulfillment._id.toString(),
            fulfillmentStatus: fulfillment.fulfillment.status,
            reused:
              attempt.reused ||
              fulfillment.reused ||
              DUPLICATE_INTENT_STATUSES.includes(current.status),
          }
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      )
    } finally {
      await session.endSession()
    }
    if (!result) {
      throw failure(
        'persistence_conflict',
        'Payment verification transaction completed without a result',
      )
    }
    return result
  },
}

/**
 * Applies the shared capture invariants after a trusted server-side Razorpay
 * fetch. Checkout callbacks call this only after HMAC verification; webhook
 * workers call it only after raw-body signature verification and local intent
 * correlation. It creates recovery ledgers only—it never grants entitlement,
 * issues an invoice, or sends a notification.
 */
export async function persistServerFetchedCapturedCheckout(
  input: PersistServerFetchedCapturedCheckoutInput,
  dependencies: PersistServerFetchedCapturedCheckoutDependencies = {},
): Promise<CapturedCheckoutVerificationResult> {
  assertExpectedKind(input.expectedKind)
  assertCanonicalPaymentId(input.requestedPaymentId)
  assertIntentCanVerify(input.intent, input.expectedKind)
  const capturedPayment = requireCapturedPayment({
    payment: input.payment,
    intent: input.intent,
    expectedKind: input.expectedKind,
    requestedPaymentId: input.requestedPaymentId,
  })
  const verifiedAt = dependencies.now?.() ?? new Date()
  if (Number.isNaN(verifiedAt.getTime())) {
    throw failure('invalid_request', 'Verification timestamp is invalid')
  }

  const store =
    dependencies.store ?? mongoCapturedCheckoutVerificationStore
  let persisted: PersistVerifiedCaptureResult
  try {
    const persistInput = persistenceInput({
      intent: input.intent,
      payment: capturedPayment,
      verifiedAt,
    })
    persisted = dependencies.commercialAnalyticsProducer
      ? await store.persistVerifiedCapture(
          persistInput,
          dependencies.commercialAnalyticsProducer,
        )
      : await store.persistVerifiedCapture(persistInput)
  } catch (error) {
    if (error instanceof CapturedCheckoutVerificationError) throw error
    throw failure(
      'persistence_conflict',
      'Verified payment could not be persisted coherently',
      error,
    )
  }

  return {
    ...persisted,
    intentId: input.intent._id.toString(),
    providerMode: input.intent.providerMode,
    razorpayPaymentId: capturedPayment.id,
    checkoutKind: input.expectedKind,
    fulfillmentKind: fulfillmentKindForIntent(input.intent.kind),
  }
}

/**
 * Verifies only a captured payment and creates recovery ledgers. It never
 * applies an entitlement, creates an invoice, or sends a notification.
 */
export async function verifyCapturedCheckout(
  input: CapturedCheckoutVerificationInput,
  dependencies: CapturedCheckoutVerificationDependencies = {},
): Promise<CapturedCheckoutVerificationResult> {
  assertExpectedKind(input.expectedKind)
  assertCanonicalPaymentId(input.razorpayPaymentId)
  const userId = parseObjectId(input.userId, 'userId')
  const intentId = parseObjectId(input.intentId, 'intentId')
  const store =
    dependencies.store ?? mongoCapturedCheckoutVerificationStore
  const intent = await store.loadIntentForUser({ intentId, userId })
  if (!intent) {
    throw failure(
      'intent_not_found',
      'Checkout intent was not found for the authenticated user',
    )
  }
  assertIntentCanVerify(intent, input.expectedKind)

  const loadCredentials =
    dependencies.loadCredentials ?? loadRazorpayApiCredentials
  let credentials: RazorpayApiCredentials
  try {
    credentials = loadCredentials(intent.providerMode)
  } catch (error) {
    throw failure(
      'provider_unavailable',
      'Razorpay credentials are unavailable for this payment mode',
      error,
    )
  }
  if (credentials.providerMode !== intent.providerMode) {
    throw failure(
      'intent_mode_mismatch',
      'Credential mode does not match the checkout intent',
    )
  }

  let signatureVerified: boolean
  try {
    signatureVerified = verifyCheckoutSignature({
      intent,
      expectedKind: input.expectedKind,
      razorpayPaymentId: input.razorpayPaymentId,
      signature: input.signature,
      keySecret: credentials.keySecret,
    })
  } catch (error) {
    throw failure(
      'invalid_request',
      'Checkout signature payload is invalid',
      error,
    )
  }
  if (!signatureVerified) {
    throw failure(
      'signature_invalid',
      'Checkout signature verification failed',
    )
  }

  const clientFactory =
    dependencies.clientFactory ?? defaultRazorpayClientFactory
  let payment: RazorpayPaymentDto
  try {
    const client = clientFactory.forMode(intent.providerMode)
    if (client.providerMode !== intent.providerMode) {
      throw failure(
        'intent_mode_mismatch',
        'Razorpay client mode does not match the checkout intent',
      )
    }
    payment = await client.fetchPayment(input.razorpayPaymentId)
  } catch (error) {
    if (error instanceof CapturedCheckoutVerificationError) throw error
    throw failure(
      'provider_unavailable',
      'Razorpay payment verification is temporarily unavailable',
      error,
    )
  }
  return persistServerFetchedCapturedCheckout(
    {
      intent,
      payment,
      requestedPaymentId: input.razorpayPaymentId,
      expectedKind: input.expectedKind,
    },
    {
      store,
      now: dependencies.now,
      commercialAnalyticsProducer:
        dependencies.commercialAnalyticsProducer,
    },
  )
}
