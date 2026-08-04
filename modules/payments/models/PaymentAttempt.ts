import mongoose, { Document, Model, Schema } from 'mongoose'
import { isInrPaise, type InrPaise } from '../lib/money'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const PAYMENT_ATTEMPT_STATUSES = [
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'disputed',
  'review',
] as const
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number]

export interface IPaymentAttempt extends Document {
  providerMode: ProviderMode
  checkoutIntentId: mongoose.Types.ObjectId
  razorpayPaymentId: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  razorpayInvoiceId?: string
  userId: mongoose.Types.ObjectId
  status: PaymentAttemptStatus
  amountPaise: InrPaise
  currency: 'INR'
  providerSnapshot: unknown
  lastSyncedAt: Date
  createdAt: Date
  updatedAt: Date
}

const PaymentAttemptSchema = new Schema<IPaymentAttempt>(
  {
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
      immutable: true,
    },
    razorpayOrderId: {
      type: String,
      trim: true,
      immutable: true,
    },
    razorpaySubscriptionId: {
      type: String,
      trim: true,
      immutable: true,
    },
    razorpayInvoiceId: {
      type: String,
      trim: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: PAYMENT_ATTEMPT_STATUSES,
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: {
        validator: isInrPaise,
        message: 'amountPaise must be non-negative safe-integer INR paise',
      },
    },
    currency: {
      type: String,
      enum: ['INR'],
      required: true,
      immutable: true,
    },
    providerSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    lastSyncedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true },
)

PaymentAttemptSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  { unique: true },
)
PaymentAttemptSchema.index({
  checkoutIntentId: 1,
  createdAt: -1,
})
PaymentAttemptSchema.index({
  userId: 1,
  providerMode: 1,
  createdAt: -1,
})
PaymentAttemptSchema.index(
  { status: 1, providerMode: 1, _id: -1 },
  { name: 'cms_payment_attempt_attention_v1' },
)
PaymentAttemptSchema.index(
  { providerMode: 1, razorpayOrderId: 1 },
  {
    partialFilterExpression: {
      razorpayOrderId: { $type: 'string' },
    },
  },
)
PaymentAttemptSchema.index(
  { providerMode: 1, razorpaySubscriptionId: 1 },
  {
    partialFilterExpression: {
      razorpaySubscriptionId: { $type: 'string' },
    },
  },
)
PaymentAttemptSchema.index(
  { providerMode: 1, razorpayInvoiceId: 1 },
  {
    partialFilterExpression: {
      razorpayInvoiceId: { $type: 'string' },
    },
  },
)

export const PaymentAttempt: Model<IPaymentAttempt> =
  mongoose.models.PaymentAttempt ||
  mongoose.model<IPaymentAttempt>(
    'PaymentAttempt',
    PaymentAttemptSchema,
  )
