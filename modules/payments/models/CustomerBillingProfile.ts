import mongoose, { Document, Model, Schema } from 'mongoose'
import { INDIA_BILLING_STATE_CODES } from '../validators/customerBillingProfile'

export interface ICustomerPlaceOfSupply {
  stateCode: (typeof INDIA_BILLING_STATE_CODES)[number]
  countryCode: 'IN'
}

export interface ICustomerBillingProfile extends Document {
  userId: mongoose.Types.ObjectId
  version: number
  placeOfSupply: ICustomerPlaceOfSupply
  contentHash: string
  lastMutationId: string
  createdAt: Date
  updatedAt: Date
}

const CustomerPlaceOfSupplySchema = new Schema<ICustomerPlaceOfSupply>(
  {
    stateCode: {
      type: String,
      required: true,
      trim: true,
      enum: INDIA_BILLING_STATE_CODES,
    },
    countryCode: {
      type: String,
      enum: ['IN'],
      required: true,
      default: 'IN',
    },
  },
  { _id: false },
)

const CustomerBillingProfileSchema = new Schema<ICustomerBillingProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    placeOfSupply: {
      type: CustomerPlaceOfSupplySchema,
      required: true,
    },
    contentHash: {
      type: String,
      required: true,
      lowercase: true,
      match: /^[a-f0-9]{64}$/,
    },
    lastMutationId: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      maxlength: 100,
      match: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    },
  },
  { timestamps: true },
)

CustomerBillingProfileSchema.index({ userId: 1 }, { unique: true })
CustomerBillingProfileSchema.index({ updatedAt: -1 })

export const CustomerBillingProfile: Model<ICustomerBillingProfile> =
  mongoose.models.CustomerBillingProfile ||
  mongoose.model<ICustomerBillingProfile>(
    'CustomerBillingProfile',
    CustomerBillingProfileSchema,
  )
