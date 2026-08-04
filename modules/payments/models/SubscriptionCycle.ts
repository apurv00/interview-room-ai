import mongoose, { Document, Model, Schema } from 'mongoose'
import { InrPaiseSchema } from '../lib/money'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export interface ICouponCampaignRevisionSnapshot {
  campaignId: mongoose.Types.ObjectId
  revision: number
}

export const SUBSCRIPTION_CYCLE_PROJECTION_DISPOSITIONS = [
  'projected',
  'financial_history',
  'financial_review',
] as const
export type SubscriptionCycleProjectionDisposition =
  (typeof SUBSCRIPTION_CYCLE_PROJECTION_DISPOSITIONS)[number]

export interface ISubscriptionCycle extends Document {
  providerMode: ProviderMode
  subscriptionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  planKey: 'plus' | 'pro'
  catalogVersion: string
  periodKey: string
  periodStart: Date
  periodEnd: Date
  razorpayInvoiceId: string
  razorpayPaymentId: string
  listPricePaise: number
  discountPaise: number
  capturedPaise: number
  currency: 'INR'
  gstInclusive: true
  gstRateBps: 1800
  gstComponentAllocation: 'unallocated'
  couponCampaignRevision?: ICouponCampaignRevisionSnapshot
  interviewLimitSnapshot: number
  premiumResumeLimitSnapshot: number
  fulfillmentStatus: 'captured'
  /**
   * Optional only for legacy rows created before lifecycle arbitration.
   * Every new cycle must persist a disposition before it can participate in
   * replay; a missing value is treated as review, never inferred.
   */
  projectionDisposition?: SubscriptionCycleProjectionDisposition
  createdAt: Date
}

const CouponCampaignRevisionSnapshotSchema =
  new Schema<ICouponCampaignRevisionSnapshot>(
    {
      campaignId: {
        type: Schema.Types.ObjectId,
        ref: 'CouponCampaign',
        required: true,
      },
      revision: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
    },
    { _id: false },
  )

const moneyValidator = {
  validator: (value: number) => InrPaiseSchema.safeParse(value).success,
  message: 'Amount must be non-negative safe-integer INR paise',
}

const nonNegativeSafeIntegerValidator = {
  validator: (value: number) => (
    Number.isSafeInteger(value) && value >= 0
  ),
  message: 'Value must be a non-negative safe integer',
}

const SubscriptionCycleSchema = new Schema<ISubscriptionCycle>(
  {
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentSubscription',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    planKey: {
      type: String,
      enum: ['plus', 'pro'],
      required: true,
      immutable: true,
    },
    catalogVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      immutable: true,
    },
    periodKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    periodStart: { type: Date, required: true, immutable: true },
    periodEnd: { type: Date, required: true, immutable: true },
    razorpayInvoiceId: {
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
    listPricePaise: {
      type: Number,
      required: true,
      validate: moneyValidator,
      immutable: true,
    },
    discountPaise: {
      type: Number,
      required: true,
      validate: moneyValidator,
      immutable: true,
    },
    capturedPaise: {
      type: Number,
      required: true,
      validate: moneyValidator,
      immutable: true,
    },
    currency: {
      type: String,
      enum: ['INR'],
      required: true,
      default: 'INR',
      immutable: true,
    },
    gstInclusive: {
      type: Boolean,
      required: true,
      default: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'Subscription-cycle prices must remain GST-inclusive',
      },
    },
    gstRateBps: {
      type: Number,
      required: true,
      enum: [1800],
      default: 1800,
      immutable: true,
    },
    gstComponentAllocation: {
      type: String,
      required: true,
      enum: ['unallocated'],
      default: 'unallocated',
      immutable: true,
    },
    couponCampaignRevision: {
      type: CouponCampaignRevisionSnapshotSchema,
      immutable: true,
    },
    interviewLimitSnapshot: {
      type: Number,
      required: true,
      validate: nonNegativeSafeIntegerValidator,
      immutable: true,
    },
    premiumResumeLimitSnapshot: {
      type: Number,
      required: true,
      validate: nonNegativeSafeIntegerValidator,
      immutable: true,
    },
    fulfillmentStatus: {
      type: String,
      enum: ['captured'],
      required: true,
      default: 'captured',
      immutable: true,
    },
    projectionDisposition: {
      type: String,
      enum: SUBSCRIPTION_CYCLE_PROJECTION_DISPOSITIONS,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

SubscriptionCycleSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  { unique: true },
)
SubscriptionCycleSchema.index(
  { providerMode: 1, razorpayInvoiceId: 1 },
  { unique: true },
)
SubscriptionCycleSchema.index(
  { providerMode: 1, subscriptionId: 1, periodKey: 1 },
  { unique: true },
)
SubscriptionCycleSchema.index({ userId: 1, periodStart: -1 })

SubscriptionCycleSchema.pre('validate', function validateCommercialSnapshot() {
  const cycle = this as unknown as ISubscriptionCycle
  if (cycle.periodEnd <= cycle.periodStart) {
    cycle.invalidate('periodEnd', 'Period end must be after period start')
  }
  if (
    Number.isSafeInteger(cycle.listPricePaise) &&
    Number.isSafeInteger(cycle.discountPaise) &&
    Number.isSafeInteger(cycle.capturedPaise)
  ) {
    if (cycle.discountPaise > cycle.listPricePaise) {
      cycle.invalidate('discountPaise', 'Discount cannot exceed list price')
    } else if (
      cycle.capturedPaise !== cycle.listPricePaise - cycle.discountPaise
    ) {
      cycle.invalidate(
        'capturedPaise',
        'Captured amount must equal list price minus discount',
      )
    }
  }
})

const rejectSubscriptionCycleMutation =
  function rejectSubscriptionCycleMutation(): never {
    throw new Error('SubscriptionCycle is append-only')
  }

SubscriptionCycleSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  { query: true, document: false },
  rejectSubscriptionCycleMutation,
)
SubscriptionCycleSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { query: true, document: false },
  rejectSubscriptionCycleMutation,
)
SubscriptionCycleSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  rejectSubscriptionCycleMutation,
)
SubscriptionCycleSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectSubscriptionCycleMutation,
)
SubscriptionCycleSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectSubscriptionCycleMutation,
)
SubscriptionCycleSchema.pre('save', function rejectExistingCycleSave() {
  if (!this.isNew) rejectSubscriptionCycleMutation()
})

export const SubscriptionCycle: Model<ISubscriptionCycle> =
  mongoose.models.SubscriptionCycle ||
  mongoose.model<ISubscriptionCycle>(
    'SubscriptionCycle',
    SubscriptionCycleSchema,
  )
