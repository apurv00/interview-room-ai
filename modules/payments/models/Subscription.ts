import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'
import {
  CONSUMER_SUBSCRIPTION_LEASE_LANES,
  type ConsumerSubscriptionLeaseLane,
} from './ConsumerSubscriptionLease'

export const SUBSCRIPTION_STATUSES = [
  'created',
  'authenticated',
  'activation_pending',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
  'review',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const SUBSCRIPTION_SOURCES = [
  'customer',
  'admin_migration',
] as const
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number]

export interface IScheduledPlanChange {
  targetPlanKey: 'plus' | 'pro'
  effectiveAt: Date
  requestedAt: Date
  source: 'customer' | 'admin'
  planChangeRequestId?: mongoose.Types.ObjectId
}

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  planKey: 'plus' | 'pro'
  catalogVersion: string
  razorpayPlanId: string
  razorpaySubscriptionId: string
  checkoutIntentId?: mongoose.Types.ObjectId
  planChangeRequestId?: mongoose.Types.ObjectId
  replacesSubscriptionId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  status: SubscriptionStatus
  currentPeriodKey?: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAtPeriodEnd: boolean
  scheduledPlanChange?: IScheduledPlanChange
  couponCampaignId?: mongoose.Types.ObjectId
  discountedCyclesRemaining?: number
  source: SubscriptionSource
  createdAt: Date
  updatedAt: Date
}

const ScheduledPlanChangeSchema = new Schema<IScheduledPlanChange>(
  {
    targetPlanKey: {
      type: String,
      enum: ['plus', 'pro'],
      required: true,
    },
    effectiveAt: { type: Date, required: true },
    requestedAt: { type: Date, required: true },
    source: {
      type: String,
      enum: ['customer', 'admin'],
      required: true,
    },
    planChangeRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'PlanChangeRequest',
    },
  },
  { _id: false },
)

const SubscriptionSchema = new Schema<ISubscription>(
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
    planKey: {
      type: String,
      enum: ['plus', 'pro'],
      required: true,
    },
    catalogVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    razorpayPlanId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    razorpaySubscriptionId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    checkoutIntentId: {
      type: Schema.Types.ObjectId,
      ref: 'CheckoutIntent',
      immutable: true,
    },
    planChangeRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'PlanChangeRequest',
      immutable: true,
    },
    replacesSubscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentSubscription',
      immutable: true,
    },
    leaseLane: {
      type: String,
      enum: CONSUMER_SUBSCRIPTION_LEASE_LANES,
      immutable: true,
    },
    requestedStartAt: {
      type: Date,
      immutable: true,
    },
    authorizationExpiresAt: {
      type: Date,
      immutable: true,
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: 'created',
      required: true,
    },
    currentPeriodKey: {
      type: String,
      trim: true,
      maxlength: 255,
    },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    cancelAtPeriodEnd: {
      type: Boolean,
      required: true,
      default: false,
    },
    scheduledPlanChange: { type: ScheduledPlanChangeSchema },
    couponCampaignId: {
      type: Schema.Types.ObjectId,
      ref: 'CouponCampaign',
    },
    discountedCyclesRemaining: {
      type: Number,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value >= 0
        ),
        message: 'discountedCyclesRemaining must be a non-negative safe integer',
      },
    },
    source: {
      type: String,
      enum: SUBSCRIPTION_SOURCES,
      required: true,
      default: 'customer',
      immutable: true,
    },
  },
  { timestamps: true },
)

SubscriptionSchema.index(
  { providerMode: 1, razorpaySubscriptionId: 1 },
  { unique: true },
)
SubscriptionSchema.index({ userId: 1, providerMode: 1, status: 1 })
SubscriptionSchema.index({ providerMode: 1, status: 1, updatedAt: 1 })
SubscriptionSchema.index(
  { status: 1, updatedAt: 1, _id: -1 },
  { name: 'cms_subscription_attention_v1' },
)
SubscriptionSchema.index(
  { checkoutIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutIntentId: { $type: 'objectId' },
    },
  },
)
SubscriptionSchema.index(
  { planChangeRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      planChangeRequestId: { $type: 'objectId' },
    },
  },
)

SubscriptionSchema.pre('validate', function validateCurrentPeriodTuple() {
  const periodValues = [
    this.currentPeriodKey,
    this.currentPeriodStart,
    this.currentPeriodEnd,
  ]
  const presentCount = periodValues.filter((value) => value !== undefined).length
  if (presentCount !== 0 && presentCount !== periodValues.length) {
    this.invalidate(
      'currentPeriodKey',
      'Current period key, start, and end must be recorded together',
    )
  }
  if (
    this.currentPeriodStart &&
    this.currentPeriodEnd &&
    this.currentPeriodEnd <= this.currentPeriodStart
  ) {
    this.invalidate(
      'currentPeriodEnd',
      'Current period end must be after current period start',
    )
  }

  if (this.requestedStartAt && !this.authorizationExpiresAt) {
    this.invalidate(
      'authorizationExpiresAt',
      'Requested subscription start requires authorization expiry',
    )
  }
  if (
    this.requestedStartAt &&
    this.authorizationExpiresAt &&
    this.authorizationExpiresAt >= this.requestedStartAt
  ) {
    this.invalidate(
      'authorizationExpiresAt',
      'Authorization expiry must precede requested subscription start',
    )
  }

  const hasPlanChange = this.planChangeRequestId !== undefined
  const hasReplacedSubscription =
    this.replacesSubscriptionId !== undefined
  if (hasPlanChange !== hasReplacedSubscription) {
    this.invalidate(
      'planChangeRequestId',
      'Replacement lineage requires plan change and replaced subscription',
    )
  }
  if (
    hasPlanChange &&
    (
      !this.checkoutIntentId ||
      !this.leaseLane ||
      !this.requestedStartAt ||
      !this.authorizationExpiresAt
    )
  ) {
    this.invalidate(
      'planChangeRequestId',
      'Replacement subscription requires complete immutable lineage',
    )
  }
  if (
    this.replacesSubscriptionId &&
    this._id &&
    this.replacesSubscriptionId.equals(this._id)
  ) {
    this.invalidate(
      'replacesSubscriptionId',
      'Replacement subscription cannot replace itself',
    )
  }
})

export const Subscription: Model<ISubscription> =
  mongoose.models.PaymentSubscription ||
  mongoose.model<ISubscription>(
    'PaymentSubscription',
    SubscriptionSchema,
  )
