import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  COUPON_CAMPAIGN_MODES,
  type CouponCampaignMode,
} from '../types/catalog'

export interface ICouponCampaign extends Document {
  key: string
  name: string
  mode: CouponCampaignMode
  code?: string
  latestRevision: number
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const CouponCampaignSchema = new Schema<ICouponCampaign>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 80,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 160,
    },
    mode: {
      type: String,
      enum: COUPON_CAMPAIGN_MODES,
      required: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 40,
      match: /^[A-Z0-9][A-Z0-9_-]*$/,
    },
    latestRevision: { type: Number, required: true, min: 1, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

CouponCampaignSchema.index({ key: 1 }, { unique: true })
CouponCampaignSchema.index(
  { code: 1 },
  { unique: true, sparse: true },
)
CouponCampaignSchema.index({ createdAt: -1 })

export const CouponCampaign: Model<ICouponCampaign> =
  mongoose.models.CouponCampaign ||
  mongoose.model<ICouponCampaign>('CouponCampaign', CouponCampaignSchema)
