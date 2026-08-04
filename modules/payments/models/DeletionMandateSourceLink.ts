import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const DELETION_MANDATE_SOURCE_KINDS = [
  'subscription',
  'checkout_intent',
] as const
export type DeletionMandateSourceKind =
  (typeof DELETION_MANDATE_SOURCE_KINDS)[number]

export interface IDeletionMandateSourceLink extends Document {
  deletionPendingId: mongoose.Types.ObjectId
  deletionRequestId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpaySubscriptionId: string
  sourceKind: DeletionMandateSourceKind
  localSourceId: mongoose.Types.ObjectId
  razorpayCustomerId?: string
  razorpayPlanId?: string
  createdAt: Date
  updatedAt: Date
}

const DeletionMandateSourceLinkSchema =
  new Schema<IDeletionMandateSourceLink>(
    {
      deletionPendingId: {
        type: Schema.Types.ObjectId,
        ref: 'DeletionPending',
        required: true,
        immutable: true,
      },
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
      providerMode: {
        type: String,
        enum: PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      razorpaySubscriptionId: {
        type: String,
        required: true,
        trim: true,
        match: /^sub_[A-Za-z0-9]+$/,
        maxlength: 128,
        immutable: true,
      },
      sourceKind: {
        type: String,
        enum: DELETION_MANDATE_SOURCE_KINDS,
        required: true,
        immutable: true,
      },
      localSourceId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      razorpayCustomerId: {
        type: String,
        trim: true,
        match: /^cust_[A-Za-z0-9]+$/,
        maxlength: 128,
        immutable: true,
      },
      razorpayPlanId: {
        type: String,
        trim: true,
        match: /^plan_[A-Za-z0-9]+$/,
        maxlength: 128,
        immutable: true,
      },
    },
    { timestamps: true },
  )

DeletionMandateSourceLinkSchema.index(
  { sourceKind: 1, localSourceId: 1 },
  { unique: true },
)
DeletionMandateSourceLinkSchema.index(
  {
    providerMode: 1,
    razorpaySubscriptionId: 1,
    sourceKind: 1,
    localSourceId: 1,
  },
  { unique: true },
)
DeletionMandateSourceLinkSchema.index({
  deletionRequestId: 1,
  deletionPendingId: 1,
})
DeletionMandateSourceLinkSchema.index({
  userId: 1,
  providerMode: 1,
  razorpaySubscriptionId: 1,
})

export const DeletionMandateSourceLink:
Model<IDeletionMandateSourceLink> =
  mongoose.models.DeletionMandateSourceLink ||
  mongoose.model<IDeletionMandateSourceLink>(
    'DeletionMandateSourceLink',
    DeletionMandateSourceLinkSchema,
  )
