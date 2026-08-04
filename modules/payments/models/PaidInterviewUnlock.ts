import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const PAID_INTERVIEW_UNLOCK_STATUSES = [
  'available',
  'reserved',
  'consumed',
  'restored',
  'expired',
  'review',
] as const
export type PaidInterviewUnlockStatus =
  (typeof PAID_INTERVIEW_UNLOCK_STATUSES)[number]

export const PAID_INTERVIEW_MAX_DURATION_MINUTES = 30 as const

/**
 * Reviewed migration contract for the bounded expiry scanner. This is
 * intentionally not registered through `Schema.index()`: Mongoose auto-index
 * is enabled in existing deployments, and production-dark application startup
 * must never create this index. Database operations must provision the exact
 * contract through the separately approved migration/evidence workflow.
 */
export const PAID_INTERVIEW_UNLOCK_EXPIRY_SCAN_INDEX_CONTRACT =
  Object.freeze({
    key: Object.freeze({
      providerMode: 1,
      status: 1,
      validUntil: 1,
      createdAt: 1,
      _id: 1,
    }),
    options: Object.freeze({
      name: 'paid_interview_unlock_expiry_scan_v1',
    }),
  })

export interface IPaidInterviewUnlock extends Document {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  status: PaidInterviewUnlockStatus
  maxDurationMinutes: typeof PAID_INTERVIEW_MAX_DURATION_MINUTES
  validUntil: Date
  reservedSessionId?: mongoose.Types.ObjectId
  consumedSessionId?: mongoose.Types.ObjectId
  reservedAt?: Date
  consumedAt?: Date
  restoredAt?: Date
  restoreReason?: string
  createdAt: Date
  updatedAt: Date
}

const PaidInterviewUnlockSchema = new Schema<IPaidInterviewUnlock>(
  {
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
    checkoutIntentId: {
      type: Schema.Types.ObjectId,
      ref: 'CheckoutIntent',
      required: true,
      immutable: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    status: {
      type: String,
      enum: PAID_INTERVIEW_UNLOCK_STATUSES,
      required: true,
      default: 'available',
    },
    maxDurationMinutes: {
      type: Number,
      enum: [PAID_INTERVIEW_MAX_DURATION_MINUTES],
      required: true,
      default: PAID_INTERVIEW_MAX_DURATION_MINUTES,
      immutable: true,
    },
    validUntil: {
      type: Date,
      required: true,
      immutable: true,
    },
    reservedSessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
    },
    consumedSessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
    },
    reservedAt: { type: Date },
    consumedAt: { type: Date },
    restoredAt: { type: Date },
    restoreReason: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 1000,
    },
  },
  { timestamps: true },
)

PaidInterviewUnlockSchema.pre(
  'validate',
  function validateOperationalEvidence() {
    const reservationRequired =
      this.status === 'reserved' ||
      this.status === 'consumed' ||
      this.status === 'restored'
    const consumptionRequired =
      this.status === 'consumed' ||
      this.status === 'restored'

    if (
      reservationRequired &&
      (!this.reservedSessionId || !this.reservedAt)
    ) {
      this.invalidate(
        'reservedSessionId',
        'Reserved unlock state requires reservation evidence',
      )
    }

    if (
      consumptionRequired &&
      (!this.consumedSessionId || !this.consumedAt)
    ) {
      this.invalidate(
        'consumedSessionId',
        'Consumed unlock state requires consumption evidence',
      )
    }

    if (
      this.reservedSessionId &&
      this.consumedSessionId &&
      !this.reservedSessionId.equals(this.consumedSessionId)
    ) {
      this.invalidate(
        'consumedSessionId',
        'The consumed session must match the reserved session',
      )
    }

    if (this.reservedAt && this.consumedAt && this.consumedAt < this.reservedAt) {
      this.invalidate(
        'consumedAt',
        'consumedAt cannot precede reservedAt',
      )
    }

    if (
      this.status === 'restored' &&
      (!this.restoredAt || !this.restoreReason)
    ) {
      this.invalidate(
        'restoredAt',
        'Restored unlock state requires restoration evidence',
      )
    }
  },
)

PaidInterviewUnlockSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  { unique: true },
)
PaidInterviewUnlockSchema.index(
  { providerMode: 1, checkoutIntentId: 1 },
  { unique: true },
)
PaidInterviewUnlockSchema.index({
  userId: 1,
  status: 1,
  validUntil: 1,
})
PaidInterviewUnlockSchema.index(
  { reservedSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      reservedSessionId: { $type: 'objectId' },
    },
  },
)
PaidInterviewUnlockSchema.index(
  { consumedSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      consumedSessionId: { $type: 'objectId' },
    },
  },
)

export const PaidInterviewUnlock: Model<IPaidInterviewUnlock> =
  mongoose.models.PaidInterviewUnlock ||
  mongoose.model<IPaidInterviewUnlock>(
    'PaidInterviewUnlock',
    PaidInterviewUnlockSchema,
  )
