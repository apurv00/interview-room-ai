import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const COUPON_USAGE_FENCE_SCOPES = ['campaign', 'user'] as const
export type CouponUsageFenceScope =
  (typeof COUPON_USAGE_FENCE_SCOPES)[number]

export interface ICouponCampaignUsageFence extends Document {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  scope: CouponUsageFenceScope
  userId?: mongoose.Types.ObjectId
  reservedCount: number
  convertedCount: number
  createdAt: Date
  updatedAt: Date
}

const nonNegativeSafeInteger = {
  validator: (value: number) => Number.isSafeInteger(value) && value >= 0,
  message: '{PATH} must be a non-negative safe integer',
}

const CouponCampaignUsageFenceSchema =
  new Schema<ICouponCampaignUsageFence>(
    {
      providerMode: {
        type: String,
        enum: PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      campaignId: {
        type: Schema.Types.ObjectId,
        ref: 'CouponCampaign',
        required: true,
        immutable: true,
      },
      scope: {
        type: String,
        enum: COUPON_USAGE_FENCE_SCOPES,
        required: true,
        immutable: true,
      },
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        immutable: true,
      },
      reservedCount: {
        type: Number,
        required: true,
        default: 0,
        validate: nonNegativeSafeInteger,
      },
      convertedCount: {
        type: Number,
        required: true,
        default: 0,
        validate: nonNegativeSafeInteger,
      },
    },
    { timestamps: true },
  )

CouponCampaignUsageFenceSchema.index(
  { providerMode: 1, campaignId: 1, scope: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'campaign' },
  },
)
CouponCampaignUsageFenceSchema.index(
  { providerMode: 1, campaignId: 1, scope: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      scope: 'user',
      userId: { $type: 'objectId' },
    },
  },
)
CouponCampaignUsageFenceSchema.index({
  userId: 1,
  providerMode: 1,
  updatedAt: -1,
})

CouponCampaignUsageFenceSchema.pre(
  'validate',
  function validateFenceScope() {
    if (this.scope === 'campaign' && this.userId) {
      this.invalidate('userId', 'Campaign capacity cannot bind a user')
    }
    if (this.scope === 'user' && !this.userId) {
      this.invalidate('userId', 'User capacity requires a user')
    }
  },
)

export const CouponCampaignUsageFence:
Model<ICouponCampaignUsageFence> =
  mongoose.models.CouponCampaignUsageFence ||
  mongoose.model<ICouponCampaignUsageFence>(
    'CouponCampaignUsageFence',
    CouponCampaignUsageFenceSchema,
  )
