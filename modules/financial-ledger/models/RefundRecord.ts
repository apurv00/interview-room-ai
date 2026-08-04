import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  isNormalizedPaise,
  type FinancialLedgerProviderMode,
  type NormalizedPaise,
} from '../types'

export const REFUND_RECORD_STATUSES = [
  'received',
  'verified',
  'review_required',
  'resolving',
  'resolved',
  'failed',
] as const
export type RefundRecordStatus = (typeof REFUND_RECORD_STATUSES)[number]

export const REFUND_DECISION_STATUSES = [
  'pending_review',
  'required',
  'not_required',
  'completed',
  'failed',
] as const
export type RefundDecisionStatus =
  (typeof REFUND_DECISION_STATUSES)[number]

export interface ICreditNoteDecision {
  idempotencyKey: string
  status: RefundDecisionStatus
  decidedAt?: Date
  attemptedAt?: Date
  fencingToken: number
  completedAt?: Date
  creditNoteId?: mongoose.Types.ObjectId
  reason?: string
  lastError?: string
}

export interface IAccessReversalDecision {
  idempotencyKey: string
  status: RefundDecisionStatus
  decidedAt?: Date
  completedAt?: Date
  reversalReference?: string
  reason?: string
  lastError?: string
}

export interface IRefundRecord extends Document {
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: NormalizedPaise
  refundedPaise: NormalizedPaise
  currency: 'INR'
  status: RefundRecordStatus
  creditNoteDecision: ICreditNoteDecision
  accessReversalDecision: IAccessReversalDecision
  originalProviderSnapshot: unknown
  lastProviderSnapshot: unknown
  lastSyncedAt: Date
  receivedAt: Date
  processedAt?: Date
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

const moneyValidator = {
  validator: isNormalizedPaise,
  message: '{PATH} must be non-negative safe-integer INR paise',
}

const decisionFields = {
  idempotencyKey: {
    type: String,
    required: true,
    trim: true,
    minlength: 8,
    maxlength: 200,
    immutable: true,
  },
  status: {
    type: String,
    enum: REFUND_DECISION_STATUSES,
    required: true,
    default: 'pending_review',
  },
  decidedAt: { type: Date },
  completedAt: { type: Date },
  reason: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  lastError: {
    type: String,
    maxlength: 2000,
  },
} as const

const CreditNoteDecisionSchema = new Schema<ICreditNoteDecision>(
  {
    ...decisionFields,
    attemptedAt: { type: Date },
    fencingToken: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    creditNoteId: {
      type: Schema.Types.ObjectId,
      ref: 'CreditNote',
    },
  },
  { _id: false },
)

const AccessReversalDecisionSchema = new Schema<IAccessReversalDecision>(
  {
    ...decisionFields,
    reversalReference: {
      type: String,
      trim: true,
      maxlength: 255,
    },
  },
  { _id: false },
)

CreditNoteDecisionSchema.pre('validate', function validateCreditNoteDecision() {
  if (
    this.status !== 'pending_review' &&
    this.status !== 'failed' &&
    !this.decidedAt
  ) {
    this.invalidate(
      'decidedAt',
      'A credit-note decision requires decidedAt',
    )
  }
  if (this.status === 'completed' && (!this.completedAt || !this.creditNoteId)) {
    this.invalidate(
      'creditNoteId',
      'A completed credit-note decision requires completion evidence',
    )
  }
  if (this.status === 'failed' && !this.lastError) {
    this.invalidate(
      'lastError',
      'A failed credit-note decision requires lastError',
    )
  }
})

AccessReversalDecisionSchema.pre(
  'validate',
  function validateAccessReversalDecision() {
    if (
      this.status !== 'pending_review' &&
      this.status !== 'failed' &&
      !this.decidedAt
    ) {
      this.invalidate(
        'decidedAt',
        'An access-reversal decision requires decidedAt',
      )
    }
    if (
      this.status === 'completed' &&
      (!this.completedAt || !this.reversalReference)
    ) {
      this.invalidate(
        'reversalReference',
        'A completed access-reversal decision requires completion evidence',
      )
    }
    if (this.status === 'failed' && !this.lastError) {
      this.invalidate(
        'lastError',
        'A failed access-reversal decision requires lastError',
      )
    }
  },
)

const RefundRecordSchema = new Schema<IRefundRecord>(
  {
    providerMode: {
      type: String,
      enum: FINANCIAL_LEDGER_PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    razorpayRefundId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayInvoiceId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayOrderId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpaySubscriptionId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    originalCapturedPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: moneyValidator,
    },
    refundedPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: moneyValidator,
    },
    currency: {
      type: String,
      enum: ['INR'],
      required: true,
      default: 'INR',
      immutable: true,
    },
    status: {
      type: String,
      enum: REFUND_RECORD_STATUSES,
      required: true,
      default: 'review_required',
    },
    creditNoteDecision: {
      type: CreditNoteDecisionSchema,
      required: true,
    },
    accessReversalDecision: {
      type: AccessReversalDecisionSchema,
      required: true,
    },
    originalProviderSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    lastProviderSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    lastSyncedAt: {
      type: Date,
      required: true,
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    processedAt: { type: Date },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value >= 0
        ),
        message: 'attempts must be a non-negative safe integer',
      },
    },
    lastError: {
      type: String,
      maxlength: 2000,
    },
    nextAttemptAt: { type: Date },
  },
  { timestamps: true },
)

RefundRecordSchema.pre('validate', function validateRefundAmount() {
  if (
    isNormalizedPaise(this.originalCapturedPaise) &&
    isNormalizedPaise(this.refundedPaise) &&
    this.refundedPaise > this.originalCapturedPaise
  ) {
    this.invalidate(
      'refundedPaise',
      'refundedPaise cannot exceed originalCapturedPaise',
    )
  }

  if (
    this.receivedAt &&
    this.lastSyncedAt &&
    this.lastSyncedAt < this.receivedAt
  ) {
    this.invalidate(
      'lastSyncedAt',
      'lastSyncedAt cannot precede receivedAt',
    )
  }

  const processedStatuses = new Set<RefundRecordStatus>([
    'verified',
    'resolving',
    'resolved',
    'failed',
  ])
  if (processedStatuses.has(this.status) && !this.processedAt) {
    this.invalidate(
      'processedAt',
      'Processed refund state requires processedAt',
    )
  }
  if (
    this.processedAt &&
    this.receivedAt &&
    this.processedAt < this.receivedAt
  ) {
    this.invalidate(
      'processedAt',
      'processedAt cannot precede receivedAt',
    )
  }
  if (this.status === 'failed' && !this.lastError) {
    this.invalidate(
      'lastError',
      'Failed refund state requires lastError',
    )
  }
})

RefundRecordSchema.index(
  { providerMode: 1, razorpayRefundId: 1 },
  { unique: true },
)
RefundRecordSchema.index({
  providerMode: 1,
  razorpayPaymentId: 1,
  createdAt: -1,
})
RefundRecordSchema.index({
  providerMode: 1,
  razorpayInvoiceId: 1,
})
RefundRecordSchema.index({
  providerMode: 1,
  razorpayOrderId: 1,
})
RefundRecordSchema.index({
  providerMode: 1,
  razorpaySubscriptionId: 1,
})
RefundRecordSchema.index(
  {
    providerMode: 1,
    'creditNoteDecision.idempotencyKey': 1,
  },
  { unique: true },
)
RefundRecordSchema.index(
  {
    providerMode: 1,
    'accessReversalDecision.idempotencyKey': 1,
  },
  { unique: true },
)
RefundRecordSchema.index({ status: 1, nextAttemptAt: 1 })
RefundRecordSchema.index(
  {
    providerMode: 1,
    'creditNoteDecision.status': 1,
    status: 1,
    nextAttemptAt: 1,
    _id: 1,
  },
  { name: 'refund_credit_note_recovery_due_v1' },
)
RefundRecordSchema.index({ userId: 1, createdAt: -1 })

export const RefundRecord: Model<IRefundRecord> =
  mongoose.models.RefundRecord ||
  mongoose.model<IRefundRecord>('RefundRecord', RefundRecordSchema)
