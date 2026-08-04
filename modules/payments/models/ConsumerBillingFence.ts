import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  CHECKOUT_INTENT_KINDS,
  type CheckoutIntentKind,
} from './CheckoutIntent'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const CONSUMER_BILLING_FENCE_STATES = [
  'active',
  'deletion_pending',
] as const
export type ConsumerBillingFenceState =
  (typeof CONSUMER_BILLING_FENCE_STATES)[number]

export interface IConsumerBillingFence extends Document {
  userId: mongoose.Types.ObjectId
  state: ConsumerBillingFenceState
  version: number
  lastCheckoutIntentId?: mongoose.Types.ObjectId
  lastCheckoutIntentKind?: CheckoutIntentKind
  lastCheckoutProviderMode?: ProviderMode
  lastCheckoutClaimedAt?: Date
  deletionRequestedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const ConsumerBillingFenceSchema =
  new Schema<IConsumerBillingFence>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
      },
      state: {
        type: String,
        enum: CONSUMER_BILLING_FENCE_STATES,
        required: true,
      },
      version: {
        type: Number,
        required: true,
        min: 1,
        validate: {
          validator: Number.isSafeInteger,
          message: 'version must be a positive safe integer',
        },
      },
      lastCheckoutIntentId: {
        type: Schema.Types.ObjectId,
        ref: 'CheckoutIntent',
      },
      lastCheckoutIntentKind: {
        type: String,
        enum: CHECKOUT_INTENT_KINDS,
      },
      lastCheckoutProviderMode: {
        type: String,
        enum: PROVIDER_MODES,
      },
      lastCheckoutClaimedAt: { type: Date },
      deletionRequestedAt: { type: Date },
    },
    { timestamps: true },
  )

ConsumerBillingFenceSchema.pre(
  'validate',
  function validateFenceEvidence() {
    const checkoutEvidence = [
      this.lastCheckoutIntentId,
      this.lastCheckoutIntentKind,
      this.lastCheckoutProviderMode,
      this.lastCheckoutClaimedAt,
    ]
    const evidenceCount = checkoutEvidence.filter(
      (value) => value !== undefined,
    ).length
    if (evidenceCount !== 0 && evidenceCount !== checkoutEvidence.length) {
      this.invalidate(
        'lastCheckoutIntentId',
        'Checkout fence evidence must be complete',
      )
    }

    if (
      this.state === 'deletion_pending' &&
      !this.deletionRequestedAt
    ) {
      this.invalidate(
        'deletionRequestedAt',
        'Deletion-pending fence requires request evidence',
      )
    }
    if (
      this.state === 'active' &&
      this.deletionRequestedAt !== undefined
    ) {
      this.invalidate(
        'deletionRequestedAt',
        'Active fence cannot retain deletion request evidence',
      )
    }
  },
)

ConsumerBillingFenceSchema.index({ userId: 1 }, { unique: true })
ConsumerBillingFenceSchema.index({ state: 1, updatedAt: 1 })
ConsumerBillingFenceSchema.index({
  lastCheckoutIntentId: 1,
})

export const ConsumerBillingFence: Model<IConsumerBillingFence> =
  mongoose.models.ConsumerBillingFence ||
  mongoose.model<IConsumerBillingFence>(
    'ConsumerBillingFence',
    ConsumerBillingFenceSchema,
  )
