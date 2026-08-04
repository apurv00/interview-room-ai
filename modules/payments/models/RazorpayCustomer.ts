import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export interface IRazorpayCustomer extends Document {
  providerMode: ProviderMode
  userId: mongoose.Types.ObjectId
  razorpayCustomerId: string
  createdAt: Date
  updatedAt: Date
}

const RazorpayCustomerSchema = new Schema<IRazorpayCustomer>(
  {
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    razorpayCustomerId: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
  },
  { timestamps: true },
)

RazorpayCustomerSchema.index(
  { providerMode: 1, userId: 1 },
  { unique: true },
)
RazorpayCustomerSchema.index(
  { providerMode: 1, razorpayCustomerId: 1 },
  { unique: true },
)

export const RazorpayCustomer: Model<IRazorpayCustomer> =
  mongoose.models.RazorpayCustomer ||
  mongoose.model<IRazorpayCustomer>(
    'RazorpayCustomer',
    RazorpayCustomerSchema,
  )
