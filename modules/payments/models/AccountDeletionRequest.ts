import mongoose, { Document, Model, Schema } from 'mongoose'

export const ACCOUNT_DELETION_REQUEST_STATUSES = [
  'requested',
  'discovering_mandates',
  'cancelling_mandates',
  'awaiting_terminal',
  'ready_for_erasure',
  'erasing',
  'completed',
  'review',
] as const
export type AccountDeletionRequestStatus =
  (typeof ACCOUNT_DELETION_REQUEST_STATUSES)[number]

export interface IAccountDeletionRequest extends Document {
  userId: mongoose.Types.ObjectId
  idempotencyKey: string
  status: AccountDeletionRequestStatus
  requestedAt: Date
  mandateDiscoveryCompletedAt?: Date
  liveMandatesDiscovered: number
  terminalMandatesVerified: number
  erasureStartedAt?: Date
  completedAt?: Date
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

const nonNegativeSafeIntegerValidator = {
  validator: (value: number) => (
    Number.isSafeInteger(value) && value >= 0
  ),
  message: '{PATH} must be a non-negative safe integer',
}

const AccountDeletionRequestSchema =
  new Schema<IAccountDeletionRequest>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
      },
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
        enum: ACCOUNT_DELETION_REQUEST_STATUSES,
        required: true,
        default: 'requested',
      },
      requestedAt: {
        type: Date,
        required: true,
        default: Date.now,
        immutable: true,
      },
      mandateDiscoveryCompletedAt: { type: Date },
      liveMandatesDiscovered: {
        type: Number,
        required: true,
        default: 0,
        validate: nonNegativeSafeIntegerValidator,
      },
      terminalMandatesVerified: {
        type: Number,
        required: true,
        default: 0,
        validate: nonNegativeSafeIntegerValidator,
      },
      erasureStartedAt: { type: Date },
      completedAt: { type: Date },
      attempts: {
        type: Number,
        required: true,
        default: 0,
        validate: nonNegativeSafeIntegerValidator,
      },
      lastError: {
        type: String,
        maxlength: 2000,
      },
      nextAttemptAt: { type: Date },
    },
    { timestamps: true },
  )

AccountDeletionRequestSchema.pre(
  'validate',
  function validateMandateBarrier() {
    if (this.terminalMandatesVerified > this.liveMandatesDiscovered) {
      this.invalidate(
        'terminalMandatesVerified',
        'terminal mandate count cannot exceed discovered live mandates',
      )
    }

    const erasureEligibleStatuses = new Set<AccountDeletionRequestStatus>([
      'ready_for_erasure',
      'erasing',
      'completed',
    ])
    if (erasureEligibleStatuses.has(this.status)) {
      if (!this.mandateDiscoveryCompletedAt) {
        this.invalidate(
          'mandateDiscoveryCompletedAt',
          'Mandate discovery must complete before erasure',
        )
      }
      if (this.terminalMandatesVerified !== this.liveMandatesDiscovered) {
        this.invalidate(
          'terminalMandatesVerified',
          'Every discovered live mandate must be terminal before erasure',
        )
      }
    }

    if (
      (this.status === 'erasing' || this.status === 'completed') &&
      !this.erasureStartedAt
    ) {
      this.invalidate(
        'erasureStartedAt',
        'Erasure must record its start time',
      )
    }
    if (this.status === 'completed' && !this.completedAt) {
      this.invalidate(
        'completedAt',
        'Completed account deletion requires completedAt',
      )
    }
  },
)

AccountDeletionRequestSchema.index(
  // A user owns one durable deletion workflow. Retries must recover this row
  // instead of launching a second mandate-discovery/cancellation workflow.
  { userId: 1 },
  { unique: true },
)
AccountDeletionRequestSchema.index({ status: 1, nextAttemptAt: 1 })

export const AccountDeletionRequest: Model<IAccountDeletionRequest> =
  mongoose.models.AccountDeletionRequest ||
  mongoose.model<IAccountDeletionRequest>(
    'AccountDeletionRequest',
    AccountDeletionRequestSchema,
  )
