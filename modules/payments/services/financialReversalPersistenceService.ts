import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import {
  CONSUMER_CATALOG_V1,
  CURRENT_PLAN_VOCABULARY_VERSION,
} from '@shared/services/planConfig'
import {
  DisputeRecord,
  persistFinancialDisputeRecord,
  persistFinancialRefundRecord,
  RefundRecord,
  type FinancialReversalRecordDependencies,
} from '@financial-ledger'
import {
  canonicalJson,
  sha256CanonicalJson,
} from '../lib/canonicalJson'
import { isInrPaise } from '../lib/money'
import {
  ChargeFulfillment,
  type ChargeFulfillmentStatus,
  type IChargeFulfillmentSteps,
} from '../models/ChargeFulfillment'
import { PaymentAttempt } from '../models/PaymentAttempt'
import { CheckoutIntent } from '../models/CheckoutIntent'
import { PaidInterviewUnlock } from '../models/PaidInterviewUnlock'
import { ResumeEntitlement } from '../models/ResumeEntitlement'
import { Subscription } from '../models/Subscription'
import { SubscriptionCycle } from '../models/SubscriptionCycle'
import {
  RazorpayDisputeDtoSchema,
  RazorpayOrderDtoSchema,
  RazorpayPaymentDtoSchema,
  RazorpayRefundDtoSchema,
  RazorpaySubscriptionDtoSchema,
  type RazorpayDisputeDto,
  type RazorpayPaymentDto,
  type RazorpayRefundDto,
} from '../providers/razorpayServerAdapter'
import type { ProviderMode } from '../types/catalog'
import type {
  DisputeEffectInput,
  RefundEffectInput,
  WebhookDomainEffectAcknowledgement,
} from './webhookDomainDispatchService'
import {
  appendAdminAuditInSession,
} from './adminAuditService'
import type { CmsAuditActor } from '../types/admin'
import { basicCalendarMonthPeriod } from './periodKeyService'

export const FINANCIAL_REVERSAL_PERSISTENCE_ERROR_CODES = [
  'input_invalid',
  'context_missing',
  'context_conflict',
  'state_conflict',
  'persistence_conflict',
] as const
export type FinancialReversalPersistenceErrorCode =
  (typeof FINANCIAL_REVERSAL_PERSISTENCE_ERROR_CODES)[number]

export class FinancialReversalPersistenceError extends Error {
  readonly code: FinancialReversalPersistenceErrorCode

  constructor(
    code: FinancialReversalPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FinancialReversalPersistenceError'
    this.code = code
  }
}

interface TrustedReversalTarget {
  kind: 'one_time_checkout' | 'subscription'
  userId: mongoose.Types.ObjectId
  checkoutIntentId?: mongoose.Types.ObjectId
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
}

interface CommonReversalEvidence {
  operationKey: string
  inboxEventId: string
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  checkoutIntentId?: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  originalCapturedPaise: number
  currency: 'INR'
  payment: RazorpayPaymentDto
  observedAt: Date
  requiresEntitlementFence: boolean
}

export interface RefundPersistenceRequest
  extends CommonReversalEvidence {
  kind: 'refund'
  eventType: RefundEffectInput['eventType']
  razorpayRefundId: string
  refund: RazorpayRefundDto
  financialOutcome: 'pending' | 'reversed' | 'failed'
}

export interface DisputePersistenceRequest
  extends CommonReversalEvidence {
  kind: 'dispute'
  eventType: DisputeEffectInput['eventType']
  razorpayDisputeId: string
  dispute: RazorpayDisputeDto
  financialOutcome:
    | 'adverse_pending'
    | 'reversed'
    | 'favorable'
    | 'closed'
}

export interface FinancialReversalPersistenceResult {
  operationKey: string
  reused: boolean
}

export interface FinancialReversalCommercialAnalyticsEvidence {
  readonly eventName: 'refund_created' | 'dispute_created'
  readonly sourceEvidenceId: string
  readonly correlationId: string
  readonly subjectId: string
  readonly providerMode: ProviderMode
  readonly razorpayPaymentId: string
  readonly occurredAt: Date
  readonly originalCapturedPaise: number
  readonly eventAmountPaise: number
}

export interface FinancialReversalCommercialAnalyticsProducer {
  appendReversalInSession(
    evidence: () => FinancialReversalCommercialAnalyticsEvidence,
    session: ClientSession,
  ): Promise<void>
}

export interface FinancialReversalPersistenceStore {
  persistRefund(
    input: RefundPersistenceRequest,
  ): Promise<FinancialReversalPersistenceResult>
  persistDispute(
    input: DisputePersistenceRequest,
    commercialAnalyticsProducer?:
      FinancialReversalCommercialAnalyticsProducer,
  ): Promise<FinancialReversalPersistenceResult>
}

export interface FinancialReversalPersistenceDependencies {
  store?: FinancialReversalPersistenceStore
  now?: () => Date
  commercialAnalyticsProducer?:
    FinancialReversalCommercialAnalyticsProducer
}

interface LeanPaymentAttempt {
  _id: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status:
    | 'created'
    | 'authorized'
    | 'captured'
    | 'failed'
    | 'refunded'
    | 'disputed'
    | 'review'
  amountPaise: number
  currency: string
  lastSyncedAt: Date
}

interface LeanChargeFulfillment {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  userId: mongoose.Types.ObjectId
  status: ChargeFulfillmentStatus
  verifiedAmountPaise: number
  verifiedCurrency: string
  steps: IChargeFulfillmentSteps
}

interface ExactReversalContext {
  attempt: LeanPaymentAttempt
  fulfillment: LeanChargeFulfillment
  entitlementApplied: boolean
}

function failure(
  code: FinancialReversalPersistenceErrorCode,
  message: string,
  cause?: unknown,
): FinancialReversalPersistenceError {
  return new FinancialReversalPersistenceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

const financialReversalRecordDependencies:
FinancialReversalRecordDependencies = {
  evidenceComparison: {
    equivalent: (left, right) =>
      canonicalJson(left) === canonicalJson(right),
  },
  createError: (code, message) => failure(code, message),
}

function sameObjectId(
  left: mongoose.Types.ObjectId,
  right: mongoose.Types.ObjectId,
): boolean {
  return left.equals(right)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function providerCreatedAt(epochSeconds: number): Date {
  const value = new Date(epochSeconds * 1_000)
  if (
    !Number.isSafeInteger(epochSeconds) ||
    epochSeconds < 0 ||
    !validDate(value)
  ) {
    throw failure(
      'input_invalid',
      'Financial reversal provider timestamp is invalid',
    )
  }
  return value
}

function exactOptionalReference(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right
}

function assertInboxEventId(value: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw failure(
      'input_invalid',
      'Webhook inbox event identifier is invalid',
    )
  }
  return normalized
}

function assertObservedAt(value: Date): Date {
  if (!validDate(value)) {
    throw failure(
      'input_invalid',
      'Financial reversal observation timestamp is invalid',
    )
  }
  return new Date(value.getTime())
}

function assertPaymentIsCaptured(
  payment: RazorpayPaymentDto,
): void {
  if (
    payment.captured !== true ||
    !['captured', 'refunded'].includes(payment.status) ||
    !isInrPaise(payment.amountPaise) ||
    payment.amountPaise <= 0 ||
    !isInrPaise(payment.amountRefundedPaise) ||
    payment.amountRefundedPaise > payment.amountPaise
  ) {
    throw failure(
      'context_conflict',
      'Financial reversal is not backed by a captured INR payment',
    )
  }
}

function trustedTarget(
  input: RefundEffectInput | DisputeEffectInput,
  payment: RazorpayPaymentDto,
): TrustedReversalTarget {
  if (input.target.kind === 'one_time_checkout') {
    const orderResult = RazorpayOrderDtoSchema.safeParse(input.target.order)
    if (!orderResult.success) {
      throw failure(
        'input_invalid',
        'One-time reversal target has no normalized order evidence',
      )
    }
    const { intent } = input.target
    const order = orderResult.data
    if (
      !(intent._id instanceof mongoose.Types.ObjectId) ||
      !(intent.userId instanceof mongoose.Types.ObjectId) ||
      intent.providerMode !== input.providerMode ||
      order.providerMode !== input.providerMode ||
      input.providerMode !== payment.providerMode ||
      intent.razorpayOrderId !== order.id ||
      !['single_interview', 'premium_resume'].includes(intent.kind) ||
      !['payment_captured', 'fulfilled'].includes(intent.status) ||
      intent.currency !== 'INR' ||
      intent.payablePaise !== payment.amountPaise ||
      intent.receipt !== order.receipt ||
      payment.orderId !== order.id ||
      payment.subscriptionId !== undefined ||
      order.currency !== 'INR' ||
      order.status !== 'paid' ||
      order.amountPaise !== payment.amountPaise ||
      order.amountPaidPaise !== payment.amountPaise ||
      order.amountDuePaise !== 0
    ) {
      throw failure(
        'context_conflict',
        'One-time payment target conflicts with server-fetched evidence',
      )
    }
    return {
      kind: 'one_time_checkout',
      userId: intent.userId,
      checkoutIntentId: intent._id,
      razorpayOrderId: order.id,
    }
  }

  const subscriptionResult = RazorpaySubscriptionDtoSchema.safeParse(
    input.target.subscription,
  )
  if (!subscriptionResult.success) {
    throw failure(
      'input_invalid',
      'Subscription reversal target has no normalized subscription evidence',
    )
  }
  const subscription = subscriptionResult.data
  const checkout = input.target.context.checkout
  const local = input.target.context.subscription
  if (!checkout && !local) {
    throw failure(
      'context_missing',
      'Subscription reversal has no trusted local target',
    )
  }
  const userId = local?.userId ?? checkout?.userId
  if (
    !(userId instanceof mongoose.Types.ObjectId) ||
    payment.providerMode !== input.providerMode ||
    subscription.providerMode !== input.providerMode ||
    !payment.subscriptionId ||
    payment.subscriptionId !== subscription.id ||
      (
        checkout &&
        (
        !(checkout._id instanceof mongoose.Types.ObjectId) ||
        !sameObjectId(checkout.userId, userId) ||
          checkout.providerMode !== input.providerMode ||
          checkout.razorpaySubscriptionId !== subscription.id ||
          subscription.notes.checkout_receipt !== checkout.receipt
        )
    ) ||
    (
      local &&
      (
        !sameObjectId(local.userId, userId) ||
        local.providerMode !== input.providerMode ||
        local.razorpaySubscriptionId !== subscription.id ||
        local.razorpayPlanId !== subscription.planId
      )
    )
  ) {
    throw failure(
      'context_conflict',
      'Subscription payment target conflicts with trusted local evidence',
    )
  }
  return {
    kind: 'subscription',
    userId,
    ...(checkout ? { checkoutIntentId: checkout._id } : {}),
    razorpayOrderId: payment.orderId,
    razorpaySubscriptionId: subscription.id,
  }
}

function normalizeCommonInput(
  input: RefundEffectInput | DisputeEffectInput,
  observedAt: Date,
): {
  inboxEventId: string
  payment: RazorpayPaymentDto
  target: TrustedReversalTarget
} {
  const inboxEventId = assertInboxEventId(input.inboxEventId)
  const paymentResult = RazorpayPaymentDtoSchema.safeParse(input.payment)
  if (!paymentResult.success) {
    throw failure(
      'input_invalid',
      'Financial reversal requires a normalized server-fetched payment',
    )
  }
  const payment = paymentResult.data
  assertPaymentIsCaptured(payment)
  if (
    input.providerMode !== payment.providerMode ||
    input.razorpayPaymentId !== payment.id ||
    payment.currency !== 'INR'
  ) {
    throw failure(
      'context_conflict',
      'Webhook and fetched payment references do not agree',
    )
  }
  assertObservedAt(observedAt)
  return {
    inboxEventId,
    payment,
    target: trustedTarget(input, payment),
  }
}

function refundOutcome(
  status: RazorpayRefundDto['status'],
): RefundPersistenceRequest['financialOutcome'] {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'processed':
      return 'reversed'
    case 'failed':
      return 'failed'
  }
}

function disputeOutcome(
  status: RazorpayDisputeDto['status'],
): DisputePersistenceRequest['financialOutcome'] {
  switch (status) {
    case 'open':
    case 'under_review':
      return 'adverse_pending'
    case 'lost':
      return 'reversed'
    case 'won':
      return 'favorable'
    case 'closed':
      return 'closed'
  }
}

function buildRefundRequest(
  input: RefundEffectInput,
  observedAt: Date,
): RefundPersistenceRequest {
  const common = normalizeCommonInput(input, observedAt)
  const refundResult = RazorpayRefundDtoSchema.safeParse(input.refund)
  if (!refundResult.success) {
    throw failure(
      'input_invalid',
      'Refund effect requires a normalized server-fetched refund',
    )
  }
  const refund = refundResult.data
  if (
    refund.providerMode !== input.providerMode ||
    refund.id !== input.razorpayRefundId ||
    refund.paymentId !== common.payment.id ||
    refund.currency !== 'INR' ||
    refund.amountPaise > common.payment.amountPaise ||
    (
      refund.status === 'processed' &&
      common.payment.amountRefundedPaise < refund.amountPaise
    )
  ) {
    throw failure(
      'context_conflict',
      'Refund does not exactly match the captured payment',
    )
  }
  const financialOutcome = refundOutcome(refund.status)
  return {
    kind: 'refund',
    operationKey:
      `${input.providerMode}:refund:${refund.id}:` +
      `${common.inboxEventId}`,
    inboxEventId: common.inboxEventId,
    providerMode: input.providerMode,
    userId: common.target.userId,
    checkoutIntentId: common.target.checkoutIntentId,
    razorpayPaymentId: common.payment.id,
    razorpayOrderId: common.payment.orderId,
    razorpaySubscriptionId: common.payment.subscriptionId,
    razorpayInvoiceId: common.payment.invoiceId,
    originalCapturedPaise: common.payment.amountPaise,
    currency: 'INR',
    payment: common.payment,
    observedAt,
    requiresEntitlementFence: financialOutcome === 'reversed',
    eventType: input.eventType,
    razorpayRefundId: refund.id,
    refund,
    financialOutcome,
  }
}

function buildDisputeRequest(
  input: DisputeEffectInput,
  observedAt: Date,
): DisputePersistenceRequest {
  const common = normalizeCommonInput(input, observedAt)
  const disputeResult = RazorpayDisputeDtoSchema.safeParse(input.dispute)
  if (!disputeResult.success) {
    throw failure(
      'input_invalid',
      'Dispute effect requires a normalized server-fetched dispute',
    )
  }
  const dispute = disputeResult.data
  if (
    dispute.providerMode !== input.providerMode ||
    dispute.id !== input.razorpayDisputeId ||
    dispute.paymentId !== common.payment.id ||
    dispute.currency !== 'INR' ||
    dispute.amountPaise > common.payment.amountPaise ||
    dispute.amountDeductedPaise > dispute.amountPaise
  ) {
    throw failure(
      'context_conflict',
      'Dispute does not exactly match the captured payment',
    )
  }
  const financialOutcome = disputeOutcome(dispute.status)
  return {
    kind: 'dispute',
    operationKey:
      `${input.providerMode}:dispute:${dispute.id}:` +
      `${common.inboxEventId}`,
    inboxEventId: common.inboxEventId,
    providerMode: input.providerMode,
    userId: common.target.userId,
    checkoutIntentId: common.target.checkoutIntentId,
    razorpayPaymentId: common.payment.id,
    razorpayOrderId: common.payment.orderId,
    razorpaySubscriptionId: common.payment.subscriptionId,
    razorpayInvoiceId: common.payment.invoiceId,
    originalCapturedPaise: common.payment.amountPaise,
    currency: 'INR',
    payment: common.payment,
    observedAt,
    requiresEntitlementFence:
      financialOutcome === 'adverse_pending' ||
      financialOutcome === 'reversed',
    eventType: input.eventType,
    razorpayDisputeId: dispute.id,
    dispute,
    financialOutcome,
  }
}

function expectedEntitlementOperation(
  input: CommonReversalEvidence,
): string {
  return (
    `${input.providerMode}:` +
    `${input.razorpayPaymentId}:entitlement`
  )
}

function exactLocalReferences(
  input: CommonReversalEvidence,
  attempt: LeanPaymentAttempt,
  fulfillment: LeanChargeFulfillment,
): boolean {
  return (
    attempt.providerMode === input.providerMode &&
    fulfillment.providerMode === input.providerMode &&
    attempt.razorpayPaymentId === input.razorpayPaymentId &&
    fulfillment.razorpayPaymentId === input.razorpayPaymentId &&
    sameObjectId(attempt.userId, input.userId) &&
    sameObjectId(fulfillment.userId, input.userId) &&
    (
      !input.checkoutIntentId ||
      sameObjectId(attempt.checkoutIntentId, input.checkoutIntentId)
    ) &&
    exactOptionalReference(
      attempt.razorpayOrderId,
      input.razorpayOrderId,
    ) &&
    exactOptionalReference(
      fulfillment.razorpayOrderId,
      input.razorpayOrderId,
    ) &&
    exactOptionalReference(
      attempt.razorpaySubscriptionId,
      input.razorpaySubscriptionId,
    ) &&
    exactOptionalReference(
      fulfillment.razorpaySubscriptionId,
      input.razorpaySubscriptionId,
    ) &&
    exactOptionalReference(
      attempt.razorpayInvoiceId,
      input.razorpayInvoiceId,
    ) &&
    exactOptionalReference(
      fulfillment.razorpayInvoiceId,
      input.razorpayInvoiceId,
    ) &&
    attempt.amountPaise === input.originalCapturedPaise &&
    fulfillment.verifiedAmountPaise === input.originalCapturedPaise &&
    attempt.currency === 'INR' &&
    fulfillment.verifiedCurrency === 'INR'
  )
}

function exactFulfillmentFence(
  input: CommonReversalEvidence,
  fulfillment: LeanChargeFulfillment,
): { entitlementApplied: boolean } {
  const expectedVerification =
    `${input.providerMode}:${input.razorpayPaymentId}:verification`
  const verification = fulfillment.steps.verification
  const entitlement = fulfillment.steps.entitlement
  if (
    verification.status !== 'complete' ||
    verification.operationKey !== expectedVerification ||
    verification.referenceId !== input.razorpayPaymentId ||
    !validDate(verification.completedAt) ||
    entitlement.operationKey !== expectedEntitlementOperation(input)
  ) {
    throw failure(
      'context_conflict',
      'Charge fulfillment lacks exact payment verification evidence',
    )
  }
  if (
    entitlement.status !== 'pending' &&
    entitlement.status !== 'complete' &&
    entitlement.status !== 'skipped'
  ) {
    throw failure(
      'context_conflict',
      'Charge entitlement is not in a fenceable state',
    )
  }
  if (
    (
      entitlement.status === 'complete' ||
      entitlement.status === 'skipped'
    ) &&
    (
      !entitlement.referenceId ||
      !validDate(entitlement.completedAt)
    )
  ) {
    throw failure(
      'context_conflict',
      'Applied entitlement lacks durable completion evidence',
    )
  }
  const entitlementApplied = entitlement.status === 'complete'
  const entitlementSkipped = entitlement.status === 'skipped'
  if (
    (
      fulfillment.status === 'verified' &&
      (entitlementApplied || entitlementSkipped)
    ) ||
    (
      fulfillment.status === 'entitlement_skipped' &&
      !entitlementSkipped
    ) ||
    (
      fulfillment.status !== 'entitlement_skipped' &&
      fulfillment.status !== 'verified' &&
      fulfillment.status !== 'review' &&
      !entitlementApplied
    ) ||
    fulfillment.status === 'received'
  ) {
    throw failure(
      'context_conflict',
      'Charge fulfillment status conflicts with its entitlement step',
    )
  }
  return { entitlementApplied }
}

async function loadExactReversalContext(
  input: CommonReversalEvidence,
  session: ClientSession,
): Promise<ExactReversalContext> {
  const attempt = await PaymentAttempt.findOne({
    providerMode: input.providerMode,
    razorpayPaymentId: input.razorpayPaymentId,
  }).session(session).lean<LeanPaymentAttempt>()
  const fulfillment = await ChargeFulfillment.findOne({
    providerMode: input.providerMode,
    razorpayPaymentId: input.razorpayPaymentId,
  }).session(session).lean<LeanChargeFulfillment>()
  if (!attempt || !fulfillment) {
    throw failure(
      'context_missing',
      'Financial reversal has no complete local charge correlation',
    )
  }
  if (
    !exactLocalReferences(input, attempt, fulfillment) ||
    !['captured', 'refunded', 'disputed', 'review'].includes(
      attempt.status,
    ) ||
    !validDate(attempt.lastSyncedAt) ||
    attempt.lastSyncedAt.getTime() > input.observedAt.getTime()
  ) {
    throw failure(
      'context_conflict',
      'Payment attempt and charge fulfillment do not match the reversal',
    )
  }
  return {
    attempt,
    fulfillment,
    ...exactFulfillmentFence(input, fulfillment),
  }
}

function nextPaymentAttemptStatus(
  current: LeanPaymentAttempt['status'],
  input: RefundPersistenceRequest | DisputePersistenceRequest,
): LeanPaymentAttempt['status'] {
  if (!input.requiresEntitlementFence) return current
  if (input.kind === 'refund') {
    const fullyRefunded = (
      input.refund.amountPaise === input.originalCapturedPaise &&
      input.payment.amountRefundedPaise ===
        input.originalCapturedPaise
    )
    if (current === 'captured') {
      return fullyRefunded ? 'refunded' : 'review'
    }
    if (current === 'refunded' && fullyRefunded) return 'refunded'
    return 'review'
  }
  if (current === 'captured') return 'disputed'
  if (current === 'disputed') return 'disputed'
  return 'review'
}

async function updatePaymentAttempt(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  context: ExactReversalContext,
  session: ClientSession,
): Promise<void> {
  const nextStatus = nextPaymentAttemptStatus(
    context.attempt.status,
    input,
  )
  const update = await PaymentAttempt.updateOne(
    {
      _id: context.attempt._id,
      status: context.attempt.status,
      lastSyncedAt: context.attempt.lastSyncedAt,
    },
    {
      $set: {
        status: nextStatus,
        providerSnapshot: input.payment,
        lastSyncedAt: input.observedAt,
      },
    },
    { session, runValidators: true },
  )
  if (update.matchedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Payment attempt changed during reversal persistence',
    )
  }
}

async function fenceChargeFulfillment(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  context: ExactReversalContext,
  session: ClientSession,
): Promise<void> {
  if (!input.requiresEntitlementFence) return
  const entitlement = context.fulfillment.steps.entitlement
  const updated = await ChargeFulfillment.findOneAndUpdate(
    {
      _id: context.fulfillment._id,
      status: context.fulfillment.status,
      'steps.entitlement.status': entitlement.status,
      'steps.entitlement.operationKey':
        expectedEntitlementOperation(input),
      ...(entitlement.referenceId
        ? {
            'steps.entitlement.referenceId':
              entitlement.referenceId,
          }
        : {
            'steps.entitlement.referenceId': {
              $exists: false,
            },
          }),
    },
    {
      $set: {
        status: 'review',
        lastError:
          'Financial reversal requires manual entitlement review',
      },
    },
    { new: true, runValidators: true, session },
  ).lean<{
    _id: mongoose.Types.ObjectId
    status: ChargeFulfillmentStatus
  }>()
  if (!updated || updated.status !== 'review') {
    throw failure(
      'persistence_conflict',
      'Entitlement grant raced with the financial reversal fence',
    )
  }
}

type AutomaticAccessReversalDecision =
  | {
      status: 'completed'
      reason: string
      reversalReference: string
    }
  | {
      status: 'not_required'
      reason: string
    }
  | {
      status: 'pending_review'
      reason: string
    }

interface LeanOneTimeReversalIntent {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  kind: 'single_interview' | 'premium_resume'
  providerMode: ProviderMode
  status: string
  razorpayOrderId?: string
}

interface LeanSubscriptionReversalCycle {
  _id: mongoose.Types.ObjectId
  subscriptionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  periodKey: string
  periodEnd: Date
  capturedPaise: number
  razorpayPaymentId: string
}

function fullFinancialReversal(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
): boolean {
  if (input.kind === 'refund') {
    return (
      input.financialOutcome === 'reversed' &&
      input.payment.amountRefundedPaise === input.originalCapturedPaise
    )
  }
  return (
    (
      input.financialOutcome === 'adverse_pending' ||
      input.financialOutcome === 'reversed'
    ) &&
    input.dispute.amountPaise === input.originalCapturedPaise
  )
}

async function reverseOneTimeAccess(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  session: ClientSession,
): Promise<AutomaticAccessReversalDecision> {
  if (!input.checkoutIntentId || !input.razorpayOrderId) {
    return {
      status: 'pending_review',
      reason: 'one_time_reversal_mapping_missing',
    }
  }
  const intent = await CheckoutIntent.findOne({
    _id: input.checkoutIntentId,
    userId: input.userId,
    providerMode: input.providerMode,
    kind: { $in: ['single_interview', 'premium_resume'] },
    razorpayOrderId: input.razorpayOrderId,
    status: { $in: ['payment_captured', 'fulfilled', 'review'] },
  })
    .select('_id userId kind providerMode status razorpayOrderId')
    .session(session)
    .lean<LeanOneTimeReversalIntent>()
  if (!intent) {
    return {
      status: 'pending_review',
      reason: 'one_time_reversal_mapping_conflict',
    }
  }

  if (intent.kind === 'single_interview') {
    const unlock = await PaidInterviewUnlock.findOne({
      userId: input.userId,
      providerMode: input.providerMode,
      checkoutIntentId: intent._id,
      razorpayPaymentId: input.razorpayPaymentId,
    }).session(session).lean<{
      _id: mongoose.Types.ObjectId
      status: 'available' | 'reserved' | 'consumed' | 'restored' |
        'expired' | 'review'
    }>()
    if (!unlock) {
      return {
        status: 'pending_review',
        reason: 'paid_interview_unlock_missing',
      }
    }
    if (unlock.status === 'expired' || unlock.status === 'review') {
      return {
        status: 'completed',
        reason: 'paid_interview_access_already_fenced',
        reversalReference: `paid-interview:${unlock._id.toHexString()}`,
      }
    }
    const nextStatus =
      unlock.status === 'available' || unlock.status === 'restored'
        ? 'expired'
        : 'review'
    const updated = await PaidInterviewUnlock.updateOne(
      { _id: unlock._id, status: unlock.status },
      { $set: { status: nextStatus } },
      { session, runValidators: true },
    )
    if (updated.modifiedCount !== 1) {
      throw failure(
        'persistence_conflict',
        'Paid interview access changed during reversal',
      )
    }
    return {
      status: 'completed',
      reason: nextStatus === 'expired'
        ? 'unused_paid_interview_access_expired'
        : 'started_paid_interview_requires_review',
      reversalReference: `paid-interview:${unlock._id.toHexString()}`,
    }
  }

  const entitlement = await ResumeEntitlement.findOne({
    userId: input.userId,
    providerMode: input.providerMode,
    checkoutIntentId: intent._id,
    razorpayPaymentId: input.razorpayPaymentId,
    source: 'premium_resume',
  }).session(session).lean<{
    _id: mongoose.Types.ObjectId
    status: 'active' | 'expired' | 'revoked' | 'review'
  }>()
  if (!entitlement) {
    return {
      status: 'pending_review',
      reason: 'premium_resume_entitlement_missing',
    }
  }
  if (entitlement.status === 'revoked' || entitlement.status === 'expired') {
    return {
      status: 'completed',
      reason: 'premium_resume_access_already_reversed',
      reversalReference:
        `resume-entitlement:${entitlement._id.toHexString()}`,
    }
  }
  if (entitlement.status === 'review') {
    return {
      status: 'pending_review',
      reason: 'premium_resume_entitlement_requires_review',
    }
  }
  const updated = await ResumeEntitlement.updateOne(
    { _id: entitlement._id, status: 'active' },
    {
      $set: {
        status: 'revoked',
        revokeEffectiveAt: input.observedAt,
      },
    },
    { session, runValidators: true },
  )
  if (updated.modifiedCount !== 1) {
    throw failure(
      'persistence_conflict',
      'Premium resume access changed during reversal',
    )
  }
  return {
    status: 'completed',
    reason: 'premium_resume_access_revoked',
    reversalReference:
      `resume-entitlement:${entitlement._id.toHexString()}`,
  }
}

async function reverseSubscriptionAccess(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  session: ClientSession,
): Promise<AutomaticAccessReversalDecision> {
  if (!input.razorpaySubscriptionId) {
    return {
      status: 'pending_review',
      reason: 'subscription_reversal_mapping_missing',
    }
  }
  const cycle = await SubscriptionCycle.findOne({
    providerMode: input.providerMode,
    userId: input.userId,
    razorpayPaymentId: input.razorpayPaymentId,
    capturedPaise: input.originalCapturedPaise,
  })
    .select(
      '_id subscriptionId userId providerMode planKey periodKey periodEnd ' +
      'capturedPaise razorpayPaymentId',
    )
    .session(session)
    .lean<LeanSubscriptionReversalCycle>()
  if (!cycle) {
    return {
      status: 'pending_review',
      reason: 'subscription_cycle_reversal_mapping_conflict',
    }
  }
  const subscription = await Subscription.findOne({
    _id: cycle.subscriptionId,
    userId: input.userId,
    providerMode: input.providerMode,
    razorpaySubscriptionId: input.razorpaySubscriptionId,
  })
    .select('_id')
    .session(session)
    .lean<{ _id: mongoose.Types.ObjectId }>()
  if (!subscription) {
    return {
      status: 'pending_review',
      reason: 'subscription_cycle_reversal_mapping_conflict',
    }
  }

  const basicPeriod = basicCalendarMonthPeriod(input.observedAt)
  const basicInterviewLimit =
    CONSUMER_CATALOG_V1.plans.free.interview.includedPerPeriod
  const updated = await User.findOneAndUpdate(
    {
      _id: input.userId,
      plan: cycle.planKey,
      planVocabularyVersion: CURRENT_PLAN_VOCABULARY_VERSION,
      planExpiresAt: cycle.periodEnd,
      entitlementSource: 'subscription',
      usagePeriodKey: cycle.periodKey,
      buyerState: { $ne: 'deletion_pending' },
    },
    {
      $set: {
        plan: 'free',
        planVocabularyVersion: CURRENT_PLAN_VOCABULARY_VERSION,
        entitlementSource: 'free',
        usagePeriodKey: basicPeriod.key,
        interviewsUsed: 0,
        interviewLimit: basicInterviewLimit,
        monthlyInterviewsUsed: 0,
        monthlyInterviewLimit: basicInterviewLimit,
        usageResetAt: basicPeriod.end,
        premiumResumesUsed: 0,
        premiumResumeLimit: 0,
      },
      $unset: { planExpiresAt: 1 },
      $inc: { entitlementVersion: 1 },
    },
    { new: true, runValidators: true, session },
  ).select('_id plan entitlementSource usagePeriodKey').lean<{
    _id: mongoose.Types.ObjectId
    plan: string
    entitlementSource: string
    usagePeriodKey: string
  }>()
  if (updated) {
    return {
      status: 'completed',
      reason: 'fully_reversed_latest_subscription_cycle',
      reversalReference:
        `subscription-cycle:${cycle._id.toHexString()}:basic`,
    }
  }

  const current = await User.findById(input.userId)
    .select('plan planExpiresAt entitlementSource usagePeriodKey')
    .session(session)
    .lean<{
      plan?: string
      planExpiresAt?: Date
      entitlementSource?: string
      usagePeriodKey?: string
    }>()
  if (!current) {
    return {
      status: 'pending_review',
      reason: 'subscription_reversal_user_missing',
    }
  }
  if (
    current.plan === 'free' &&
    current.entitlementSource === 'free'
  ) {
    return {
      status: 'completed',
      reason: 'subscription_access_already_reversed',
      reversalReference:
        `subscription-cycle:${cycle._id.toHexString()}:basic`,
    }
  }
  if (
    current.usagePeriodKey !== cycle.periodKey ||
    current.planExpiresAt?.getTime() !== cycle.periodEnd.getTime()
  ) {
    return {
      status: 'not_required',
      reason: 'newer_or_different_entitlement_authority_preserved',
    }
  }
  return {
    status: 'pending_review',
    reason: 'subscription_entitlement_projection_conflict',
  }
}

async function applyAutomaticAccessReversal(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  context: ExactReversalContext,
  session: ClientSession,
): Promise<AutomaticAccessReversalDecision> {
  if (!input.requiresEntitlementFence || !context.entitlementApplied) {
    return {
      status: 'not_required',
      reason: context.entitlementApplied
        ? 'provider_reversal_not_adverse'
        : 'entitlement_was_not_applied',
    }
  }
  if (!fullFinancialReversal(input)) {
    return {
      status: 'pending_review',
      reason: 'partial_financial_reversal_requires_review',
    }
  }
  return input.razorpaySubscriptionId
    ? reverseSubscriptionAccess(input, session)
    : reverseOneTimeAccess(input, session)
}

async function persistAutomaticAccessDecision(
  input: RefundPersistenceRequest | DisputePersistenceRequest,
  decision: AutomaticAccessReversalDecision,
  session: ClientSession,
): Promise<void> {
  if (decision.status === 'pending_review') return
  if (
    decision.status === 'not_required' &&
    (
      decision.reason === 'provider_reversal_not_adverse' ||
      decision.reason === 'entitlement_was_not_applied'
    )
  ) {
    return
  }
  const identity = input.kind === 'refund'
    ? { razorpayRefundId: input.razorpayRefundId }
    : { razorpayDisputeId: input.razorpayDisputeId }
  const updateFilter = {
    providerMode: input.providerMode,
    ...identity,
    'accessReversalDecision.status': {
      $in: ['pending_review', 'required', 'not_required'],
    },
  }
  const updateDocument = {
    $set: {
      'accessReversalDecision.status': decision.status,
      'accessReversalDecision.decidedAt': input.observedAt,
      'accessReversalDecision.reason': decision.reason,
      ...(decision.status === 'completed'
        ? {
            'accessReversalDecision.completedAt': input.observedAt,
            'accessReversalDecision.reversalReference':
              decision.reversalReference,
          }
        : {}),
    },
  }
  const update = input.kind === 'refund'
    ? await RefundRecord.updateOne(
        updateFilter,
        updateDocument,
        { session, runValidators: true },
      )
    : await DisputeRecord.updateOne(
        updateFilter,
        updateDocument,
        { session, runValidators: true },
      )
  if (update.matchedCount === 1) return
  const current = input.kind === 'refund'
    ? await RefundRecord.findOne({
        providerMode: input.providerMode,
        razorpayRefundId: input.razorpayRefundId,
      }).session(session).lean<{
        accessReversalDecision?: { status?: string }
      }>()
    : await DisputeRecord.findOne({
        providerMode: input.providerMode,
        razorpayDisputeId: input.razorpayDisputeId,
      }).session(session).lean<{
        accessReversalDecision?: { status?: string }
      }>()
  if (current?.accessReversalDecision?.status !== decision.status) {
    throw failure(
      'persistence_conflict',
      'Financial access decision changed concurrently',
    )
  }
}

export interface PaymentRefundLocalEffectCandidate {
  readonly candidateDigest: string
  readonly intentId: string
  readonly requestDigest: string
  readonly observationId: string
  readonly observationDigest: string
  readonly commandDigest: string
  readonly idempotencyKey: string
  readonly providerMode: ProviderMode
  readonly operation: 'refund'
  readonly amount: {
    readonly valuePaise: number
    readonly currency: 'INR'
  }
  readonly finalizedBy: string
  readonly finalizedAt: Date
}

export interface PersistPaymentRefundOperationEffectInput {
  readonly effect: RefundEffectInput
  readonly observedAt: Date
  readonly candidate: PaymentRefundLocalEffectCandidate
  readonly authority: {
    readonly actor: CmsAuditActor
    readonly requestId: string
    readonly correlationId: string
    readonly authorityDigest: string
  }
}

interface LeanPersistedRefundEffect {
  _id: mongoose.Types.ObjectId
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  razorpayRefundId: string
  razorpayPaymentId: string
  refundedPaise: number
  currency: string
  status: string
  creditNoteDecision: {
    idempotencyKey: string
    status: string
    reason?: string
  }
  accessReversalDecision: {
    idempotencyKey: string
    status: string
    reason?: string
  }
  lastSyncedAt: Date
}

const FINANCIAL_DIGEST = /^[a-f0-9]{64}$/
const FINANCIAL_OBJECT_ID = /^[a-f0-9]{24}$/

/**
 * Persists a conclusive worker-observed refund inside the financial intent's
 * caller-owned transaction and returns an exact local-effect attestation.
 */
export async function persistPaymentRefundOperationEffectInSession(
  input: PersistPaymentRefundOperationEffectInput,
  session: ClientSession,
  commercialAnalyticsProducer?:
    FinancialReversalCommercialAnalyticsProducer,
): Promise<{
  readonly schemaVersion: 'financial_local_effect_attestation_v1'
  readonly attestationId: string
  readonly candidateDigest: string
  readonly intentId: string
  readonly requestDigest: string
  readonly observationId: string
  readonly observationDigest: string
  readonly commandDigest: string
  readonly idempotencyKey: string
  readonly providerMode: ProviderMode
  readonly operation: 'refund'
  readonly amount: {
    readonly valuePaise: number
    readonly currency: 'INR'
  }
  readonly result: 'applied' | 'no_change'
  readonly resultReference: string
  readonly resultDigest: string
  readonly verifiedAt: Date
  readonly attestationDigest: string
}> {
  if (!session?.inTransaction()) {
    throw failure(
      'input_invalid',
      'Refund operation finalization requires an active transaction',
    )
  }
  const { candidate, effect } = input
  if (
    !FINANCIAL_OBJECT_ID.test(candidate.intentId) ||
    !FINANCIAL_OBJECT_ID.test(candidate.finalizedBy) ||
    ![
      candidate.candidateDigest,
      candidate.requestDigest,
      candidate.observationDigest,
      candidate.commandDigest,
      input.authority.authorityDigest,
    ].every((value) => FINANCIAL_DIGEST.test(value)) ||
    candidate.operation !== 'refund' ||
    candidate.providerMode !== effect.providerMode ||
    candidate.amount.currency !== 'INR' ||
    candidate.amount.valuePaise !== effect.refund.amountPaise ||
    effect.refund.currency !== 'INR' ||
    !['processed', 'failed'].includes(effect.refund.status) ||
    !validDate(candidate.finalizedAt) ||
    !validDate(input.observedAt) ||
    candidate.finalizedAt < input.observedAt
  ) {
    throw failure(
      'input_invalid',
      'Refund local effect does not bind conclusive financial evidence',
    )
  }

  const request = buildRefundRequest(effect, input.observedAt)
  const context = await loadExactReversalContext(request, session)
  await fenceChargeFulfillment(request, context, session)
  await updatePaymentAttempt(request, context, session)
  await persistFinancialRefundRecord(
    request,
    {
      entitlementApplied: context.entitlementApplied,
      fulfillmentStatus: context.fulfillment.status,
    },
    session,
    financialReversalRecordDependencies,
  )
  const record = await RefundRecord.findOne({
    providerMode: request.providerMode,
    razorpayRefundId: request.razorpayRefundId,
  })
    .select(
      '_id providerMode userId razorpayRefundId razorpayPaymentId ' +
      'refundedPaise currency status creditNoteDecision ' +
      'accessReversalDecision lastSyncedAt',
    )
    .session(session)
    .lean<LeanPersistedRefundEffect>()
    .exec()
  if (
    !record ||
    record.providerMode !== request.providerMode ||
    !record.userId.equals(request.userId) ||
    record.razorpayRefundId !== request.razorpayRefundId ||
    record.razorpayPaymentId !== request.razorpayPaymentId ||
    record.refundedPaise !== request.refund.amountPaise ||
    record.currency !== 'INR' ||
    (
      request.financialOutcome === 'reversed' &&
      record.status === 'failed'
    ) ||
    (
      request.financialOutcome === 'failed' &&
      record.status !== 'failed'
    ) ||
    !validDate(record.lastSyncedAt) ||
    record.lastSyncedAt.getTime() !== input.observedAt.getTime()
  ) {
    throw failure(
      'persistence_conflict',
      'Persisted RefundRecord does not attest the exact local effect',
    )
  }
  const resultEvidence = {
    schemaVersion: 'payment_refund_local_effect_v1' as const,
    refundRecordId: record._id.toHexString(),
    providerMode: record.providerMode,
    userId: record.userId.toHexString(),
    razorpayRefundId: record.razorpayRefundId,
    razorpayPaymentId: record.razorpayPaymentId,
    refundedPaise: record.refundedPaise,
    currency: 'INR' as const,
    status: record.status,
    creditNoteDecision: record.creditNoteDecision,
    accessReversalDecision: record.accessReversalDecision,
    observedAt: record.lastSyncedAt.toISOString(),
  }
  const resultDigest = sha256CanonicalJson(resultEvidence)
  const auditMutationId =
    `cms_refund_recorded_${candidate.intentId}`
  await appendAdminAuditInSession({
    actor: input.authority.actor,
    mutationId: auditMutationId,
    correlationId: input.authority.correlationId,
    requestId: input.authority.requestId,
    action: 'refund_recorded',
    targetType: 'RefundRecord',
    targetId: resultEvidence.refundRecordId,
    reason:
      'Automated execution of the exact refund approved in the CMS.',
    before: {
      schemaVersion: 'cms_refund_recording_authority_v1',
      intentId: candidate.intentId,
      requestDigest: candidate.requestDigest,
      observationId: candidate.observationId,
      observationDigest: candidate.observationDigest,
      authorityDigest: input.authority.authorityDigest,
    },
    after: resultEvidence,
  }, session)
  if (request.refund.status === 'processed') {
    await commercialAnalyticsProducer?.appendReversalInSession(
      () => Object.freeze({
        eventName: 'refund_created' as const,
        sourceEvidenceId: request.refund.id,
        correlationId:
          context.attempt.checkoutIntentId.toHexString(),
        subjectId: request.userId.toHexString(),
        providerMode: request.providerMode,
        razorpayPaymentId: request.razorpayPaymentId,
        occurredAt: providerCreatedAt(
          request.refund.createdAtEpochSeconds,
        ),
        originalCapturedPaise: request.originalCapturedPaise,
        eventAmountPaise: request.refund.amountPaise,
      }),
      session,
    )
  }

  const verifiedAt = new Date()
  const attestationWithoutDigest = {
    schemaVersion:
      'financial_local_effect_attestation_v1' as const,
    attestationId:
      `refund_local_effect_${candidate.intentId}`,
    candidateDigest: candidate.candidateDigest,
    intentId: candidate.intentId,
    requestDigest: candidate.requestDigest,
    observationId: candidate.observationId,
    observationDigest: candidate.observationDigest,
    commandDigest: candidate.commandDigest,
    idempotencyKey: candidate.idempotencyKey,
    providerMode: candidate.providerMode,
    operation: 'refund' as const,
    amount: candidate.amount,
    result: effect.refund.status === 'processed'
      ? 'applied' as const
      : 'no_change' as const,
    resultReference: resultEvidence.refundRecordId,
    resultDigest,
    verifiedAt,
  }
  return Object.freeze({
    ...attestationWithoutDigest,
    amount: Object.freeze({ ...attestationWithoutDigest.amount }),
    verifiedAt: Object.freeze(new Date(verifiedAt)),
    attestationDigest:
      sha256CanonicalJson(attestationWithoutDigest),
  })
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (
      ('code' in error && error.code === 11000) ||
      (
        'cause' in error &&
        isDuplicateKeyError(error.cause)
      )
    ),
  )
}

async function persistRefundOnce(
  input: RefundPersistenceRequest,
): Promise<FinancialReversalPersistenceResult> {
  const session = await mongoose.startSession()
  let reused = false
  try {
    await session.withTransaction(async () => {
      const context = await loadExactReversalContext(input, session)
      await fenceChargeFulfillment(input, context, session)
      await updatePaymentAttempt(input, context, session)
      reused = await persistFinancialRefundRecord(
        input,
        {
          entitlementApplied: context.entitlementApplied,
          fulfillmentStatus: context.fulfillment.status,
        },
        session,
        financialReversalRecordDependencies,
      )
      const accessDecision = await applyAutomaticAccessReversal(
        input,
        context,
        session,
      )
      await persistAutomaticAccessDecision(
        input,
        accessDecision,
        session,
      )
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  return { operationKey: input.operationKey, reused }
}

async function persistDisputeOnce(
  input: DisputePersistenceRequest,
  commercialAnalyticsProducer?:
    FinancialReversalCommercialAnalyticsProducer,
): Promise<FinancialReversalPersistenceResult> {
  const session = await mongoose.startSession()
  let reused = false
  try {
    await session.withTransaction(async () => {
      const context = await loadExactReversalContext(input, session)
      await fenceChargeFulfillment(input, context, session)
      await updatePaymentAttempt(input, context, session)
      reused = await persistFinancialDisputeRecord(
        input,
        {
          entitlementApplied: context.entitlementApplied,
          fulfillmentStatus: context.fulfillment.status,
        },
        session,
        financialReversalRecordDependencies,
      )
      const accessDecision = await applyAutomaticAccessReversal(
        input,
        context,
        session,
      )
      await persistAutomaticAccessDecision(
        input,
        accessDecision,
        session,
      )
      if (input.eventType === 'payment.dispute.created') {
        await commercialAnalyticsProducer?.appendReversalInSession(
          () => Object.freeze({
            eventName: 'dispute_created' as const,
            sourceEvidenceId: input.razorpayDisputeId,
            correlationId:
              context.attempt.checkoutIntentId.toHexString(),
            subjectId: input.userId.toHexString(),
            providerMode: input.providerMode,
            razorpayPaymentId: input.razorpayPaymentId,
            occurredAt: providerCreatedAt(
              input.dispute.createdAtEpochSeconds,
            ),
            originalCapturedPaise: input.originalCapturedPaise,
            eventAmountPaise: input.dispute.amountPaise,
          }),
          session,
        )
      }
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
  } finally {
    await session.endSession()
  }
  return { operationKey: input.operationKey, reused }
}

export const mongoFinancialReversalPersistenceStore:
FinancialReversalPersistenceStore = {
  async persistRefund(input) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await persistRefundOnce(input)
      } catch (error) {
        if (attempt === 0 && isDuplicateKeyError(error)) continue
        throw error
      }
    }
    throw failure(
      'persistence_conflict',
      'Refund persistence exhausted concurrency recovery',
    )
  },

  async persistDispute(input, commercialAnalyticsProducer) {
    await connectDB()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await persistDisputeOnce(
          input,
          commercialAnalyticsProducer,
        )
      } catch (error) {
        if (attempt === 0 && isDuplicateKeyError(error)) continue
        throw error
      }
    }
    throw failure(
      'persistence_conflict',
      'Dispute persistence exhausted concurrency recovery',
    )
  },
}

async function handledResult(
  action: () => Promise<FinancialReversalPersistenceResult>,
): Promise<WebhookDomainEffectAcknowledgement> {
  let result: FinancialReversalPersistenceResult
  try {
    result = await action()
  } catch (error) {
    if (error instanceof FinancialReversalPersistenceError) throw error
    throw failure(
      'persistence_conflict',
      'Financial reversal could not be persisted coherently',
      error,
    )
  }
  if (
    !result.operationKey ||
    result.operationKey.length > 255
  ) {
    throw failure(
      'persistence_conflict',
      'Financial reversal store returned an invalid operation key',
    )
  }
  return {
    outcome: 'handled',
    operationKey: result.operationKey,
  }
}

/**
 * Persists a real, server-fetched Razorpay refund. This path never creates a
 * refund at the provider and never fabricates a refund identifier.
 */
export async function persistRefundWebhookEffect(
  input: RefundEffectInput,
  dependencies: FinancialReversalPersistenceDependencies = {},
): Promise<WebhookDomainEffectAcknowledgement> {
  const observedAt = assertObservedAt(
    dependencies.now?.() ?? new Date(),
  )
  const request = buildRefundRequest(input, observedAt)
  const store =
    dependencies.store ?? mongoFinancialReversalPersistenceStore
  return handledResult(() => store.persistRefund(request))
}

/**
 * Appends dispute evidence and fences grants for adverse states. A favorable
 * or closed event is audit-only here: entitlement restoration always requires
 * a separate reviewed operation.
 */
export async function persistDisputeWebhookEffect(
  input: DisputeEffectInput,
  dependencies: FinancialReversalPersistenceDependencies = {},
): Promise<WebhookDomainEffectAcknowledgement> {
  const observedAt = assertObservedAt(
    dependencies.now?.() ?? new Date(),
  )
  const request = buildDisputeRequest(input, observedAt)
  const store =
    dependencies.store ?? mongoFinancialReversalPersistenceStore
  return handledResult(() => (
    dependencies.commercialAnalyticsProducer
      ? store.persistDispute(
          request,
          dependencies.commercialAnalyticsProducer,
        )
      : store.persistDispute(request)
  ))
}
