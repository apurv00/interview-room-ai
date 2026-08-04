import mongoose, { Document, Model, Schema } from 'mongoose'

export const DELETION_MANDATE_DISCOVERY_STAGES = [
  'test_subscriptions',
  'test_checkout_intents',
  'live_subscriptions',
  'live_checkout_intents',
  'complete',
] as const
export type DeletionMandateDiscoveryStage =
  (typeof DELETION_MANDATE_DISCOVERY_STAGES)[number]

export interface IDeletionMandateDiscoveryProgress extends Document {
  deletionRequestId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  stage: DeletionMandateDiscoveryStage
  afterObjectId?: mongoose.Types.ObjectId
  completedAt?: Date
  attempts: number
  lastError?: string
  nextAttemptAt?: Date
  createdAt: Date
  updatedAt: Date
}

const DeletionMandateDiscoveryProgressSchema =
  new Schema<IDeletionMandateDiscoveryProgress>(
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
      stage: {
        type: String,
        enum: DELETION_MANDATE_DISCOVERY_STAGES,
        required: true,
        default: 'test_subscriptions',
      },
      afterObjectId: { type: Schema.Types.ObjectId },
      completedAt: { type: Date },
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
        trim: true,
        maxlength: 2000,
      },
      nextAttemptAt: { type: Date },
    },
    { timestamps: true },
  )

DeletionMandateDiscoveryProgressSchema.pre(
  'validate',
  function validateCompletionState() {
    if (this.stage === 'complete') {
      if (!this.completedAt) {
        this.invalidate(
          'completedAt',
          'Completed mandate discovery requires completedAt',
        )
      }
      if (this.afterObjectId !== undefined) {
        this.invalidate(
          'afterObjectId',
          'Completed mandate discovery cannot retain a cursor',
        )
      }
      return
    }
    if (this.completedAt !== undefined) {
      this.invalidate(
        'completedAt',
        'Incomplete mandate discovery cannot carry completedAt',
      )
    }
  },
)

DeletionMandateDiscoveryProgressSchema.index(
  { deletionRequestId: 1 },
  { unique: true },
)
DeletionMandateDiscoveryProgressSchema.index(
  { stage: 1, nextAttemptAt: 1, updatedAt: 1 },
)

export const DeletionMandateDiscoveryProgress:
Model<IDeletionMandateDiscoveryProgress> =
  mongoose.models.DeletionMandateDiscoveryProgress ||
  mongoose.model<IDeletionMandateDiscoveryProgress>(
    'DeletionMandateDiscoveryProgress',
    DeletionMandateDiscoveryProgressSchema,
  )
