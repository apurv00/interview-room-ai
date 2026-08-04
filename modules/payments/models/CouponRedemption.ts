import mongoose, {
  Document,
  Model,
  Schema,
} from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export interface ICouponRedemption extends Document {
  providerMode: ProviderMode
  reservationId: mongoose.Types.ObjectId
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  subscriptionId?: string
  orderId?: string
  paymentId: string
  catalogVersion: string
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycleNumber: number
  requiresReview: boolean
  createdAt: Date
}

const CouponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    reservationId: {
      type: Schema.Types.ObjectId,
      ref: 'CouponReservation',
      required: true,
      immutable: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: 'CouponCampaign',
      required: true,
      immutable: true,
    },
    campaignRevision: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    checkoutIntentId: {
      type: Schema.Types.ObjectId,
      ref: 'CheckoutIntent',
      required: true,
      immutable: true,
    },
    subscriptionId: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    orderId: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    paymentId: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    catalogVersion: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
      immutable: true,
    },
    codeSnapshot: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 40,
      immutable: true,
    },
    discountPaise: {
      type: Number,
      enum: [5000, 10000, 15000, 20000],
      required: true,
      immutable: true,
    },
    discountedBillingCycleNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    requiresReview: {
      type: Boolean,
      required: true,
      immutable: true,
      default: false,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

CouponRedemptionSchema.index(
  { providerMode: 1, paymentId: 1 },
  { unique: true },
)
CouponRedemptionSchema.index(
  {
    providerMode: 1,
    checkoutIntentId: 1,
    discountedBillingCycleNumber: 1,
  },
  { unique: true },
)
CouponRedemptionSchema.index({
  providerMode: 1,
  campaignId: 1,
  userId: 1,
  createdAt: -1,
})
CouponRedemptionSchema.index(
  {
    providerMode: 1,
    campaignId: 1,
    userId: 1,
    subscriptionId: 1,
    discountedBillingCycleNumber: 1,
  },
  {
    unique: true,
    partialFilterExpression: { subscriptionId: { $type: 'string' } },
  },
)

CouponRedemptionSchema.pre('validate', function validateRedemptionTarget() {
  const targets = Number(Boolean(this.subscriptionId)) +
    Number(Boolean(this.orderId))
  if (targets !== 1) {
    this.invalidate(
      'subscriptionId',
      'Coupon redemption requires exactly one provider purchase target',
    )
  }
})

const rejectCouponRedemptionMutation =
  function rejectCouponRedemptionMutation(): never {
    throw new Error('CouponRedemption is append-only')
  }

CouponRedemptionSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { query: true, document: false },
  rejectCouponRedemptionMutation,
)
CouponRedemptionSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectCouponRedemptionMutation,
)
CouponRedemptionSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectCouponRedemptionMutation,
)
CouponRedemptionSchema.pre('save', function rejectExistingRedemptionSave() {
  if (!this.isNew) rejectCouponRedemptionMutation()
})

export const CouponRedemption: Model<ICouponRedemption> =
  mongoose.models.CouponRedemption ||
  mongoose.model<ICouponRedemption>(
    'CouponRedemption',
    CouponRedemptionSchema,
  )
