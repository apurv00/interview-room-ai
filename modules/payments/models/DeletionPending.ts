import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const DELETION_PENDING_STATUSES = [
  'discovered',
  'cancel_requested',
  'awaiting_terminal',
  'retry_pending',
  'terminal_verified',
  'review',
] as const
export type DeletionPendingStatus =
  (typeof DELETION_PENDING_STATUSES)[number]

export const TERMINAL_MANDATE_STATUSES = [
  'cancelled',
  'completed',
  'expired',
] as const
export type TerminalMandateStatus =
  (typeof TERMINAL_MANDATE_STATUSES)[number]

export function deletionPendingBlocksErasure(
  status: DeletionPendingStatus,
): boolean {
  return status !== 'terminal_verified'
}

export interface IDeletionPending extends Document {
  deletionRequestId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  razorpayCustomerId?: string
  razorpayPlanId?: string
  localSubscriptionId?: mongoose.Types.ObjectId
  cancelIdempotencyKey: string
  status: DeletionPendingStatus
  lastProviderStatus?: string
  discoveredAt: Date
  cancelRequestedAt?: Date
  terminalVerifiedAt?: Date
  terminalProviderStatus?: TerminalMandateStatus
  lastProviderSnapshot?: unknown
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

const DeletionPendingSchema = new Schema<IDeletionPending>(
  {
    deletionRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountDeletionRequest',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    razorpaySubscriptionId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayCustomerId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpayPlanId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    localSubscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentSubscription',
      immutable: true,
    },
    cancelIdempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      maxlength: 200,
      immutable: true,
    },
    status: {
      type: String,
      enum: DELETION_PENDING_STATUSES,
      required: true,
      default: 'discovered',
    },
    lastProviderStatus: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    discoveredAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    cancelRequestedAt: { type: Date },
    terminalVerifiedAt: { type: Date },
    terminalProviderStatus: {
      type: String,
      enum: TERMINAL_MANDATE_STATUSES,
    },
    lastProviderSnapshot: {
      type: Schema.Types.Mixed,
    },
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

DeletionPendingSchema.pre('validate', function validateTerminalEvidence() {
  if (this.status === 'terminal_verified') {
    if (!this.terminalVerifiedAt || !this.terminalProviderStatus) {
      this.invalidate(
        'terminalVerifiedAt',
        'Terminal mandate state requires provider verification evidence',
      )
    }
  } else if (
    this.terminalVerifiedAt !== undefined ||
    this.terminalProviderStatus !== undefined
  ) {
    this.invalidate(
      'terminalVerifiedAt',
      'Only terminal_verified mandates may carry terminal evidence',
    )
  }

  if (
    (
      this.status === 'cancel_requested' ||
      this.status === 'awaiting_terminal'
    ) &&
    !this.cancelRequestedAt
  ) {
    this.invalidate(
      'cancelRequestedAt',
      'Cancellation workflow state requires cancelRequestedAt',
    )
  }
})

DeletionPendingSchema.index(
  {
    providerMode: 1,
    razorpaySubscriptionId: 1,
  },
  // A provider mandate may belong to only one deletion workflow in a mode.
  // This prevents concurrent requests from cancelling the same mandate twice.
  { unique: true },
)
DeletionPendingSchema.index(
  { providerMode: 1, cancelIdempotencyKey: 1 },
  { unique: true },
)
DeletionPendingSchema.index({
  providerMode: 1,
  razorpaySubscriptionId: 1,
  status: 1,
})
DeletionPendingSchema.index({
  providerMode: 1,
  razorpayCustomerId: 1,
})
DeletionPendingSchema.index({
  providerMode: 1,
  razorpayPlanId: 1,
})
DeletionPendingSchema.index({
  deletionRequestId: 1,
  status: 1,
})
DeletionPendingSchema.index({
  userId: 1,
  status: 1,
  updatedAt: 1,
})

export const DeletionPending: Model<IDeletionPending> =
  mongoose.models.DeletionPending ||
  mongoose.model<IDeletionPending>(
    'DeletionPending',
    DeletionPendingSchema,
  )
