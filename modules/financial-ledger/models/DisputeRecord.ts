import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  isNormalizedPaise,
  type FinancialLedgerProviderMode,
  type NormalizedPaise,
} from '../types'
import {
  REFUND_DECISION_STATUSES,
  type RefundDecisionStatus,
} from './RefundRecord'

export const DISPUTE_RECORD_STATUSES = [
  'open',
  'under_review',
  'won',
  'lost',
  'closed',
] as const
export type DisputeRecordStatus =
  (typeof DISPUTE_RECORD_STATUSES)[number]

export const DISPUTE_RECORD_EVENT_TYPES = [
  'payment.dispute.created',
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
  'payment.dispute.under_review',
  'payment.dispute.action_required',
] as const
export type DisputeRecordEventType =
  (typeof DISPUTE_RECORD_EVENT_TYPES)[number]

export interface IDisputeCreditNoteDecision {
  idempotencyKey: string
  status: RefundDecisionStatus
  decidedAt?: Date
  completedAt?: Date
  creditNoteId?: mongoose.Types.ObjectId
  reason?: string
  lastError?: string
}

export interface IDisputeAccessReversalDecision {
  idempotencyKey: string
  status: RefundDecisionStatus
  decidedAt?: Date
  completedAt?: Date
  reversalReference?: string
  reason?: string
  lastError?: string
}

export interface IDisputeHistoryEntry {
  operationKey: string
  inboxEventId: string
  eventType: DisputeRecordEventType
  providerStatus: DisputeRecordStatus
  amountDeductedPaise: NormalizedPaise
  providerSnapshot: unknown
  observedAt: Date
}

export interface IDisputeRecord extends Document {
  providerMode: FinancialLedgerProviderMode
  userId: mongoose.Types.ObjectId
  razorpayDisputeId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: NormalizedPaise
  disputedPaise: NormalizedPaise
  amountDeductedPaise: NormalizedPaise
  currency: 'INR'
  status: DisputeRecordStatus
  creditNoteDecision: IDisputeCreditNoteDecision
  accessReversalDecision: IDisputeAccessReversalDecision
  originalProviderSnapshot: unknown
  lastProviderSnapshot: unknown
  history: IDisputeHistoryEntry[]
  receivedAt: Date
  lastSyncedAt: Date
  attempts: number
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

const DisputeCreditNoteDecisionSchema =
  new Schema<IDisputeCreditNoteDecision>(
    {
      ...decisionFields,
      creditNoteId: {
        type: Schema.Types.ObjectId,
        ref: 'CreditNote',
      },
    },
    { _id: false },
  )

const DisputeAccessReversalDecisionSchema =
  new Schema<IDisputeAccessReversalDecision>(
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

function validateCreditNoteDecision(
  this: IDisputeCreditNoteDecision & {
    invalidate: (path: string, message: string) => void
  },
): void {
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
  if (
    this.status === 'completed' &&
    (!this.completedAt || !this.creditNoteId)
  ) {
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
}

function validateAccessReversalDecision(
  this: IDisputeAccessReversalDecision & {
    invalidate: (path: string, message: string) => void
  },
): void {
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
}

DisputeCreditNoteDecisionSchema.pre(
  'validate',
  validateCreditNoteDecision,
)
DisputeAccessReversalDecisionSchema.pre(
  'validate',
  validateAccessReversalDecision,
)

const DisputeHistoryEntrySchema = new Schema<IDisputeHistoryEntry>(
  {
    operationKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    inboxEventId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    eventType: {
      type: String,
      enum: DISPUTE_RECORD_EVENT_TYPES,
      required: true,
      immutable: true,
    },
    providerStatus: {
      type: String,
      enum: DISPUTE_RECORD_STATUSES,
      required: true,
      immutable: true,
    },
    amountDeductedPaise: {
      type: Number,
      required: true,
      validate: moneyValidator,
      immutable: true,
    },
    providerSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    observedAt: {
      type: Date,
      required: true,
      immutable: true,
    },
  },
  { _id: false },
)

const DisputeRecordSchema = new Schema<IDisputeRecord>(
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
    razorpayDisputeId: {
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
      validate: moneyValidator,
      immutable: true,
    },
    disputedPaise: {
      type: Number,
      required: true,
      validate: moneyValidator,
      immutable: true,
    },
    amountDeductedPaise: {
      type: Number,
      required: true,
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
      enum: DISPUTE_RECORD_STATUSES,
      required: true,
    },
    creditNoteDecision: {
      type: DisputeCreditNoteDecisionSchema,
      required: true,
    },
    accessReversalDecision: {
      type: DisputeAccessReversalDecisionSchema,
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
    history: {
      type: [DisputeHistoryEntrySchema],
      required: true,
      default: [],
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    lastSyncedAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 1,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value > 0
        ),
        message: 'attempts must be a positive safe integer',
      },
    },
  },
  { timestamps: true },
)

DisputeRecordSchema.pre('validate', function validateDisputeRecord() {
  if (
    isNormalizedPaise(this.originalCapturedPaise) &&
    isNormalizedPaise(this.disputedPaise) &&
    this.disputedPaise > this.originalCapturedPaise
  ) {
    this.invalidate(
      'disputedPaise',
      'disputedPaise cannot exceed originalCapturedPaise',
    )
  }
  if (
    isNormalizedPaise(this.amountDeductedPaise) &&
    isNormalizedPaise(this.disputedPaise) &&
    this.amountDeductedPaise > this.disputedPaise
  ) {
    this.invalidate(
      'amountDeductedPaise',
      'amountDeductedPaise cannot exceed disputedPaise',
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
  if (!Array.isArray(this.history) || this.history.length === 0) {
    this.invalidate(
      'history',
      'A dispute record requires immutable observation history',
    )
    return
  }
  const operationKeys = this.history.map((entry) => entry.operationKey)
  if (new Set(operationKeys).size !== operationKeys.length) {
    this.invalidate(
      'history',
      'Dispute observation operation keys must be unique',
    )
  }
})

DisputeRecordSchema.index(
  { providerMode: 1, razorpayDisputeId: 1 },
  { unique: true },
)
DisputeRecordSchema.index({
  providerMode: 1,
  razorpayPaymentId: 1,
  createdAt: -1,
})
DisputeRecordSchema.index(
  { providerMode: 1, 'history.operationKey': 1 },
  { unique: true },
)
DisputeRecordSchema.index(
  {
    providerMode: 1,
    'creditNoteDecision.idempotencyKey': 1,
  },
  { unique: true },
)
DisputeRecordSchema.index(
  {
    providerMode: 1,
    'accessReversalDecision.idempotencyKey': 1,
  },
  { unique: true },
)
DisputeRecordSchema.index({ userId: 1, createdAt: -1 })
DisputeRecordSchema.index({ status: 1, lastSyncedAt: 1 })

export const DisputeRecord: Model<IDisputeRecord> =
  mongoose.models.DisputeRecord ||
  mongoose.model<IDisputeRecord>(
    'DisputeRecord',
    DisputeRecordSchema,
  )
