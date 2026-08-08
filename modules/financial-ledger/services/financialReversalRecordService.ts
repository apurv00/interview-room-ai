import mongoose, { type ClientSession } from 'mongoose'
import {
  DisputeRecord,
  type DisputeRecordEventType,
  type DisputeRecordStatus,
  type IDisputeAccessReversalDecision,
  type IDisputeCreditNoteDecision,
  type IDisputeHistoryEntry,
} from '../models/DisputeRecord'
import {
  RefundRecord,
  type IAccessReversalDecision,
  type ICreditNoteDecision,
  type RefundRecordStatus,
} from '../models/RefundRecord'
import type {
  FinancialEvidenceComparisonPort,
  FinancialLedgerProviderMode,
} from '../types'

export type FinancialRecordPersistenceErrorCode =
  | 'input_invalid'
  | 'context_missing'
  | 'context_conflict'
  | 'state_conflict'
  | 'persistence_conflict'

export interface FinancialRefundEvidence {
  status: 'pending' | 'processed' | 'failed'
  amountPaise: number
}

export interface FinancialDisputeEvidence {
  status: DisputeRecordStatus
  amountPaise: number
  amountDeductedPaise: number
}

interface CommonFinancialReversalRecordRequest {
  operationKey: string
  inboxEventId: string
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  originalCapturedPaise: number
  observedAt: Date
}

export interface FinancialRefundRecordRequest
extends CommonFinancialReversalRecordRequest {
  eventType: string
  razorpayRefundId: string
  refund: FinancialRefundEvidence
  financialOutcome: 'pending' | 'reversed' | 'failed'
}

export interface FinancialDisputeRecordRequest
extends CommonFinancialReversalRecordRequest {
  eventType: string
  razorpayDisputeId: string
  dispute: FinancialDisputeEvidence
  financialOutcome:
    | 'adverse_pending'
    | 'reversed'
    | 'favorable'
    | 'closed'
}

export interface FinancialReversalGrantContext {
  entitlementApplied: boolean
  fulfillmentStatus: string
  financialDocumentIssued: boolean
}

export interface FinancialReversalRecordDependencies {
  evidenceComparison: FinancialEvidenceComparisonPort
  createError(
    code: FinancialRecordPersistenceErrorCode,
    message: string,
  ): Error
}

interface LeanRefundRecord {
  _id: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: number
  refundedPaise: number
  currency: string
  status: RefundRecordStatus
  creditNoteDecision: ICreditNoteDecision
  accessReversalDecision: IAccessReversalDecision
  originalProviderSnapshot: unknown
  lastProviderSnapshot: unknown
  lastSyncedAt: Date
  receivedAt: Date
  processedAt?: Date
  attempts: number
}

interface LeanDisputeRecord {
  _id: mongoose.Types.ObjectId
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  razorpayDisputeId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: number
  disputedPaise: number
  amountDeductedPaise: number
  currency: string
  status: DisputeRecordStatus
  creditNoteDecision: IDisputeCreditNoteDecision
  accessReversalDecision: IDisputeAccessReversalDecision
  originalProviderSnapshot: unknown
  lastProviderSnapshot: unknown
  history: IDisputeHistoryEntry[]
  receivedAt: Date
  lastSyncedAt: Date
  attempts: number
}

type CreditDecision =
  | ICreditNoteDecision
  | IDisputeCreditNoteDecision
type AccessDecision =
  | IAccessReversalDecision
  | IDisputeAccessReversalDecision

function fail(
  dependencies: FinancialReversalRecordDependencies,
  code: FinancialRecordPersistenceErrorCode,
  message: string,
): never {
  throw dependencies.createError(code, message)
}

function sameObjectId(left: unknown, right: unknown): boolean {
  return (
    left instanceof mongoose.Types.ObjectId &&
    right instanceof mongoose.Types.ObjectId &&
    left.equals(right)
  )
}

function exactOptionalReference(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right
}

function creditDecision(
  existing: CreditDecision | undefined,
  desired: 'pending_review' | 'required' | 'not_required',
  reason: string,
  decidedAt: Date,
  idempotencyKey: string,
): CreditDecision {
  if (
    existing &&
    !['pending_review', 'not_required'].includes(existing.status)
  ) {
    return existing
  }
  if (
    existing?.status === 'not_required' &&
    desired === 'pending_review'
  ) {
    return existing
  }
  if (desired === 'pending_review') {
    return {
      idempotencyKey: existing?.idempotencyKey ?? idempotencyKey,
      status: 'pending_review',
      reason,
    }
  }
  return {
    idempotencyKey: existing?.idempotencyKey ?? idempotencyKey,
    status: desired,
    decidedAt,
    reason,
  }
}

function accessDecision(
  existing: AccessDecision | undefined,
  desired: 'pending_review' | 'not_required',
  reason: string,
  decidedAt: Date,
  idempotencyKey: string,
): AccessDecision {
  if (
    existing &&
    !['pending_review', 'not_required'].includes(existing.status)
  ) {
    return existing
  }
  if (
    existing?.status === 'pending_review' &&
    desired === 'not_required'
  ) {
    return existing
  }
  if (desired === 'pending_review') {
    return {
      idempotencyKey: existing?.idempotencyKey ?? idempotencyKey,
      status: 'pending_review',
      reason,
    }
  }
  return {
    idempotencyKey: existing?.idempotencyKey ?? idempotencyKey,
    status: 'not_required',
    decidedAt,
    reason,
  }
}

function failedRefundAccessDecision(
  existing: AccessDecision | undefined,
  decidedAt: Date,
  idempotencyKey: string,
): AccessDecision {
  if (
    existing &&
    !['pending_review', 'not_required'].includes(existing.status)
  ) {
    return existing
  }
  return {
    idempotencyKey: existing?.idempotencyKey ?? idempotencyKey,
    status: 'not_required',
    decidedAt,
    reason: 'provider_refund_failed',
  }
}

function refundProviderState(
  record: LeanRefundRecord,
): FinancialRefundEvidence['status'] {
  switch (record.status) {
    case 'received':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'verified':
    case 'review_required':
    case 'resolving':
    case 'resolved':
      return 'processed'
  }
}

function assertRefundStateTransition(
  existing: LeanRefundRecord,
  input: FinancialRefundRecordRequest,
  dependencies: FinancialReversalRecordDependencies,
): void {
  const current = refundProviderState(existing)
  if (
    current !== input.refund.status &&
    current !== 'pending'
  ) {
    fail(
      dependencies,
      'state_conflict',
      'Refund provider state regressed after local processing',
    )
  }
}

function exactRefundRecord(
  record: LeanRefundRecord,
  input: FinancialRefundRecordRequest,
): boolean {
  return (
    record.providerMode === input.providerMode &&
    sameObjectId(record.userId, input.userId) &&
    record.razorpayRefundId === input.razorpayRefundId &&
    record.razorpayPaymentId === input.razorpayPaymentId &&
    exactOptionalReference(
      record.razorpayInvoiceId,
      input.razorpayInvoiceId,
    ) &&
    exactOptionalReference(
      record.razorpayOrderId,
      input.razorpayOrderId,
    ) &&
    exactOptionalReference(
      record.razorpaySubscriptionId,
      input.razorpaySubscriptionId,
    ) &&
    record.originalCapturedPaise === input.originalCapturedPaise &&
    record.refundedPaise === input.refund.amountPaise &&
    record.currency === 'INR'
  )
}

function refundSnapshot(input: FinancialRefundRecordRequest): unknown {
  return {
    operationKey: input.operationKey,
    inboxEventId: input.inboxEventId,
    eventType: input.eventType,
    refund: input.refund,
  }
}

function desiredRefundStatus(
  input: FinancialRefundRecordRequest,
  existing?: LeanRefundRecord,
): RefundRecordStatus {
  if (input.financialOutcome === 'pending') {
    return existing?.status ?? 'received'
  }
  if (input.financialOutcome === 'failed') return 'failed'
  if (
    existing &&
    ['resolving', 'resolved'].includes(existing.status)
  ) {
    return existing.status
  }
  return 'review_required'
}

function refundDecisions(input: {
  request: FinancialRefundRecordRequest
  context: FinancialReversalGrantContext
  existing?: LeanRefundRecord
}): {
  creditNoteDecision: CreditDecision
  accessReversalDecision: AccessDecision
} {
  const { request, context, existing } = input
  const creditKey =
    `${request.providerMode}:${request.razorpayRefundId}:credit-note`
  const accessKey =
    `${request.providerMode}:${request.razorpayRefundId}:access`
  if (request.financialOutcome === 'reversed') {
    return {
      creditNoteDecision: creditDecision(
        existing?.creditNoteDecision,
        context.financialDocumentIssued ? 'required' : 'not_required',
        context.financialDocumentIssued
          ? 'provider_refund_processed'
          : 'individual_purchase_financial_document_not_issued',
        request.observedAt,
        creditKey,
      ),
      accessReversalDecision: accessDecision(
        existing?.accessReversalDecision,
        context.entitlementApplied ? 'pending_review' : 'not_required',
        context.entitlementApplied
          ? 'entitlement_already_applied'
          : 'entitlement_grant_fenced',
        request.observedAt,
        accessKey,
      ),
    }
  }
  if (request.financialOutcome === 'failed') {
    return {
      creditNoteDecision: creditDecision(
        existing?.creditNoteDecision,
        'not_required',
        'provider_refund_failed',
        request.observedAt,
        creditKey,
      ),
      accessReversalDecision: failedRefundAccessDecision(
        existing?.accessReversalDecision,
        request.observedAt,
        accessKey,
      ),
    }
  }
  return {
    creditNoteDecision: creditDecision(
      existing?.creditNoteDecision,
      'pending_review',
      'provider_refund_pending',
      request.observedAt,
      creditKey,
    ),
    accessReversalDecision: accessDecision(
      existing?.accessReversalDecision,
      'pending_review',
      'provider_refund_pending',
      request.observedAt,
      accessKey,
    ),
  }
}

export async function persistFinancialRefundRecord(
  input: FinancialRefundRecordRequest,
  context: FinancialReversalGrantContext,
  session: ClientSession,
  dependencies: FinancialReversalRecordDependencies,
): Promise<boolean> {
  const existing = await RefundRecord.findOne({
    providerMode: input.providerMode,
    razorpayRefundId: input.razorpayRefundId,
  }).session(session).lean<LeanRefundRecord>()
  if (existing) {
    if (!exactRefundRecord(existing, input)) {
      fail(
        dependencies,
        'context_conflict',
        'Existing refund record conflicts with provider evidence',
      )
    }
    assertRefundStateTransition(existing, input, dependencies)
  }
  const snapshot = refundSnapshot(input)
  const decisions = refundDecisions({
    request: input,
    context,
    existing: existing ?? undefined,
  })
  if (!existing) {
    await RefundRecord.create([{
      providerMode: input.providerMode,
      userId: input.userId,
      razorpayRefundId: input.razorpayRefundId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayInvoiceId: input.razorpayInvoiceId,
      razorpayOrderId: input.razorpayOrderId,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      originalCapturedPaise: input.originalCapturedPaise,
      refundedPaise: input.refund.amountPaise,
      currency: 'INR',
      status: desiredRefundStatus(input),
      ...decisions,
      originalProviderSnapshot: snapshot,
      lastProviderSnapshot: snapshot,
      lastSyncedAt: input.observedAt,
      receivedAt: input.observedAt,
      ...(input.financialOutcome !== 'pending'
        ? { processedAt: input.observedAt }
        : {}),
      ...(input.financialOutcome === 'failed'
        ? {
            lastError:
              'Razorpay reported the refund as failed',
          }
        : {}),
      attempts: 1,
    }], { session })
    return false
  }
  const update = await RefundRecord.updateOne(
    {
      _id: existing._id,
      status: existing.status,
      lastSyncedAt: existing.lastSyncedAt,
    },
    {
      $set: {
        status: desiredRefundStatus(input, existing),
        ...decisions,
        lastProviderSnapshot: snapshot,
        lastSyncedAt: input.observedAt,
        ...(input.financialOutcome !== 'pending'
          ? {
              processedAt:
                existing.processedAt ?? input.observedAt,
            }
          : {}),
        ...(input.financialOutcome === 'failed'
          ? {
              lastError:
                'Razorpay reported the refund as failed',
            }
          : {}),
      },
      $inc: { attempts: 1 },
    },
    { session, runValidators: true },
  )
  if (update.matchedCount !== 1) {
    fail(
      dependencies,
      'persistence_conflict',
      'Refund record changed during persistence',
    )
  }
  return true
}

function exactDisputeRecord(
  record: LeanDisputeRecord,
  input: FinancialDisputeRecordRequest,
): boolean {
  return (
    record.providerMode === input.providerMode &&
    sameObjectId(record.userId, input.userId) &&
    record.razorpayDisputeId === input.razorpayDisputeId &&
    record.razorpayPaymentId === input.razorpayPaymentId &&
    exactOptionalReference(
      record.razorpayInvoiceId,
      input.razorpayInvoiceId,
    ) &&
    exactOptionalReference(
      record.razorpayOrderId,
      input.razorpayOrderId,
    ) &&
    exactOptionalReference(
      record.razorpaySubscriptionId,
      input.razorpaySubscriptionId,
    ) &&
    record.originalCapturedPaise === input.originalCapturedPaise &&
    record.disputedPaise === input.dispute.amountPaise &&
    record.currency === 'INR'
  )
}

function disputeSnapshot(
  input: FinancialDisputeRecordRequest,
): unknown {
  return {
    operationKey: input.operationKey,
    inboxEventId: input.inboxEventId,
    eventType: input.eventType,
    dispute: input.dispute,
  }
}

function disputeHistoryEntry(
  input: FinancialDisputeRecordRequest,
): IDisputeHistoryEntry {
  return {
    operationKey: input.operationKey,
    inboxEventId: input.inboxEventId,
    eventType: input.eventType as DisputeRecordEventType,
    providerStatus: input.dispute.status,
    amountDeductedPaise: input.dispute.amountDeductedPaise,
    providerSnapshot: disputeSnapshot(input),
    observedAt: input.observedAt,
  }
}

function exactHistoryReplay(
  entry: IDisputeHistoryEntry,
  expected: IDisputeHistoryEntry,
  dependencies: FinancialReversalRecordDependencies,
): boolean {
  return (
    entry.operationKey === expected.operationKey &&
    entry.inboxEventId === expected.inboxEventId &&
    entry.eventType === expected.eventType &&
    entry.providerStatus === expected.providerStatus &&
    entry.amountDeductedPaise === expected.amountDeductedPaise &&
    dependencies.evidenceComparison.equivalent(
      entry.providerSnapshot,
      expected.providerSnapshot,
    )
  )
}

function disputeDecisions(input: {
  request: FinancialDisputeRecordRequest
  context: FinancialReversalGrantContext
  existing?: LeanDisputeRecord
}): {
  creditNoteDecision: CreditDecision
  accessReversalDecision: AccessDecision
} {
  const { request, context, existing } = input
  const creditKey =
    `${request.providerMode}:${request.razorpayDisputeId}:credit-note`
  const accessKey =
    `${request.providerMode}:${request.razorpayDisputeId}:access`
  const priorAdverse = Boolean(
    existing?.history.some((entry) => (
      ['open', 'under_review', 'lost'].includes(entry.providerStatus)
    )),
  )
  if (request.financialOutcome === 'reversed') {
    return {
      creditNoteDecision: creditDecision(
        existing?.creditNoteDecision,
        context.financialDocumentIssued
          ? 'pending_review'
          : 'not_required',
        context.financialDocumentIssued
          ? 'provider_dispute_lost_requires_manual_accounting_review'
          : 'individual_purchase_financial_document_not_issued',
        request.observedAt,
        creditKey,
      ),
      accessReversalDecision: accessDecision(
        existing?.accessReversalDecision,
        context.entitlementApplied ? 'pending_review' : 'not_required',
        context.entitlementApplied
          ? 'entitlement_already_applied'
          : 'entitlement_grant_fenced',
        request.observedAt,
        accessKey,
      ),
    }
  }
  if (request.financialOutcome === 'favorable') {
    const requiresReview =
      priorAdverse || context.fulfillmentStatus === 'review'
    return {
      creditNoteDecision: creditDecision(
        existing?.creditNoteDecision,
        'not_required',
        'provider_dispute_won',
        request.observedAt,
        creditKey,
      ),
      accessReversalDecision: accessDecision(
        existing?.accessReversalDecision,
        requiresReview ? 'pending_review' : 'not_required',
        requiresReview
          ? 'favorable_dispute_requires_manual_entitlement_review'
          : 'no_entitlement_fence_was_applied',
        request.observedAt,
        accessKey,
      ),
    }
  }
  return {
    creditNoteDecision: creditDecision(
      existing?.creditNoteDecision,
      'pending_review',
      request.financialOutcome === 'closed'
        ? 'provider_dispute_closed_requires_review'
        : 'provider_dispute_pending',
      request.observedAt,
      creditKey,
    ),
    accessReversalDecision: accessDecision(
      existing?.accessReversalDecision,
      'pending_review',
      request.financialOutcome === 'closed'
        ? 'closed_dispute_requires_manual_entitlement_review'
        : 'provider_dispute_pending',
      request.observedAt,
      accessKey,
    ),
  }
}

export async function persistFinancialDisputeRecord(
  input: FinancialDisputeRecordRequest,
  context: FinancialReversalGrantContext,
  session: ClientSession,
  dependencies: FinancialReversalRecordDependencies,
): Promise<boolean> {
  const existing = await DisputeRecord.findOne({
    providerMode: input.providerMode,
    razorpayDisputeId: input.razorpayDisputeId,
  }).session(session).lean<LeanDisputeRecord>()
  if (existing && !exactDisputeRecord(existing, input)) {
    fail(
      dependencies,
      'context_conflict',
      'Existing dispute record conflicts with provider evidence',
    )
  }
  const snapshot = disputeSnapshot(input)
  const historyEntry = disputeHistoryEntry(input)
  const existingHistory = existing?.history.find(
    (entry) => entry.operationKey === input.operationKey,
  )
  if (
    existingHistory &&
    !exactHistoryReplay(existingHistory, historyEntry, dependencies)
  ) {
    fail(
      dependencies,
      'state_conflict',
      'Dispute operation key was previously used for different evidence',
    )
  }
  const decisions = disputeDecisions({
    request: input,
    context,
    existing: existing ?? undefined,
  })
  if (!existing) {
    await DisputeRecord.create([{
      providerMode: input.providerMode,
      userId: input.userId,
      razorpayDisputeId: input.razorpayDisputeId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayInvoiceId: input.razorpayInvoiceId,
      razorpayOrderId: input.razorpayOrderId,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      originalCapturedPaise: input.originalCapturedPaise,
      disputedPaise: input.dispute.amountPaise,
      amountDeductedPaise: input.dispute.amountDeductedPaise,
      currency: 'INR',
      status: input.dispute.status,
      ...decisions,
      originalProviderSnapshot: snapshot,
      lastProviderSnapshot: snapshot,
      history: [historyEntry],
      receivedAt: input.observedAt,
      lastSyncedAt: input.observedAt,
      attempts: 1,
    }], { session })
    return false
  }
  const update = await DisputeRecord.updateOne(
    {
      _id: existing._id,
      status: existing.status,
      lastSyncedAt: existing.lastSyncedAt,
    },
    {
      $set: {
        status: input.dispute.status,
        amountDeductedPaise: input.dispute.amountDeductedPaise,
        ...decisions,
        lastProviderSnapshot: snapshot,
        lastSyncedAt: input.observedAt,
      },
      ...(existingHistory
        ? {}
        : {
            $push: { history: historyEntry },
            $inc: { attempts: 1 },
          }),
    },
    { session, runValidators: true },
  )
  if (update.matchedCount !== 1) {
    fail(
      dependencies,
      'persistence_conflict',
      'Dispute record changed during persistence',
    )
  }
  return existingHistory !== undefined
}
