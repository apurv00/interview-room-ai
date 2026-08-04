import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const CONSUMER_SUBSCRIPTION_LEASE_STATUSES = [
  'held',
  'release_pending',
  'released',
  'review',
] as const
export type ConsumerSubscriptionLeaseStatus =
  (typeof CONSUMER_SUBSCRIPTION_LEASE_STATUSES)[number]

export const CONSUMER_SUBSCRIPTION_LEASE_LANES = ['a', 'b'] as const
export type ConsumerSubscriptionLeaseLane =
  (typeof CONSUMER_SUBSCRIPTION_LEASE_LANES)[number]

export const CONSUMER_SUBSCRIPTION_LEASE_RELEASE_REASONS = [
  'remote_terminal_verified',
  'operator_resolved',
] as const
export type ConsumerSubscriptionLeaseReleaseReason =
  (typeof CONSUMER_SUBSCRIPTION_LEASE_RELEASE_REASONS)[number]

export function consumerSubscriptionLeaseBlocksCheckout(
  status: ConsumerSubscriptionLeaseStatus,
): boolean {
  return status !== 'released'
}

export interface IConsumerSubscriptionLease extends Document {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  lane: ConsumerSubscriptionLeaseLane
  ownerCheckoutIntentId: mongoose.Types.ObjectId
  razorpaySubscriptionId?: string
  status: ConsumerSubscriptionLeaseStatus
  acquiredAt: Date
  remoteTerminalVerifiedAt?: Date
  releasedAt?: Date
  releaseReason?: ConsumerSubscriptionLeaseReleaseReason
  releasedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const ConsumerSubscriptionLeaseSchema =
  new Schema<IConsumerSubscriptionLease>(
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
      lane: {
        type: String,
        enum: CONSUMER_SUBSCRIPTION_LEASE_LANES,
        required: true,
        default: 'a',
        immutable: true,
      },
      ownerCheckoutIntentId: {
        type: Schema.Types.ObjectId,
        ref: 'CheckoutIntent',
        required: true,
      },
      razorpaySubscriptionId: {
        type: String,
        trim: true,
      },
      status: {
        type: String,
        enum: CONSUMER_SUBSCRIPTION_LEASE_STATUSES,
        required: true,
        default: 'held',
      },
      acquiredAt: {
        type: Date,
        required: true,
        default: Date.now,
      },
      remoteTerminalVerifiedAt: { type: Date },
      releasedAt: { type: Date },
      releaseReason: {
        type: String,
        enum: CONSUMER_SUBSCRIPTION_LEASE_RELEASE_REASONS,
      },
      releasedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    },
    { timestamps: true },
  )

ConsumerSubscriptionLeaseSchema.pre(
  'validate',
  function validateExplicitReleaseEvidence() {
    if (this.status !== 'released') {
      if (this.releasedAt !== undefined) {
        this.invalidate(
          'releasedAt',
          'releasedAt is only valid for an explicitly released lease',
        )
      }
      if (this.releaseReason !== undefined) {
        this.invalidate(
          'releaseReason',
          'releaseReason is only valid for an explicitly released lease',
        )
      }
      if (this.releasedBy !== undefined) {
        this.invalidate(
          'releasedBy',
          'releasedBy is only valid for an explicitly released lease',
        )
      }
      return
    }

    if (!this.releasedAt) {
      this.invalidate(
        'releasedAt',
        'An explicitly released lease requires releasedAt',
      )
    }
    if (!this.releaseReason) {
      this.invalidate(
        'releaseReason',
        'An explicitly released lease requires releaseReason',
      )
      return
    }
    if (
      this.releaseReason === 'remote_terminal_verified' &&
      !this.remoteTerminalVerifiedAt
    ) {
      this.invalidate(
        'remoteTerminalVerifiedAt',
        'Remote terminal release requires provider verification evidence',
      )
    }
    if (
      this.releaseReason === 'operator_resolved' &&
      !this.releasedBy
    ) {
      this.invalidate(
        'releasedBy',
        'Operator release requires the resolving user',
      )
    }
  },
)

ConsumerSubscriptionLeaseSchema.index(
  { userId: 1, providerMode: 1, lane: 1 },
  {
    unique: true,
    name: 'uq_consumer_subscription_lease_user_mode_lane',
  },
)
ConsumerSubscriptionLeaseSchema.index(
  { providerMode: 1, razorpaySubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpaySubscriptionId: { $type: 'string' },
    },
  },
)
ConsumerSubscriptionLeaseSchema.index({
  providerMode: 1,
  ownerCheckoutIntentId: 1,
})
ConsumerSubscriptionLeaseSchema.index({
  status: 1,
  updatedAt: 1,
})

export const ConsumerSubscriptionLease: Model<IConsumerSubscriptionLease> =
  mongoose.models.ConsumerSubscriptionLease ||
  mongoose.model<IConsumerSubscriptionLease>(
    'ConsumerSubscriptionLease',
    ConsumerSubscriptionLeaseSchema,
  )
