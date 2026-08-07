import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  INDIA_GST_RATE_BPS,
  isInrPaise,
  type InrPaise,
} from '../lib/money'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'
import {
  CONSUMER_SUBSCRIPTION_LEASE_LANES,
  type ConsumerSubscriptionLeaseLane,
} from './ConsumerSubscriptionLease'

export const CHECKOUT_INTENT_KINDS = [
  'subscription',
  'single_interview',
  'premium_resume',
] as const
export type CheckoutIntentKind = (typeof CHECKOUT_INTENT_KINDS)[number]

export const CHECKOUT_INTENT_PURPOSES = [
  'acquisition',
  'replacement',
  'resubscribe',
] as const
export type CheckoutIntentPurpose =
  (typeof CHECKOUT_INTENT_PURPOSES)[number]

export const CHECKOUT_INTENT_STATUSES = [
  'created',
  'remote_created',
  'checkout_opened',
  'authorization_pending',
  'payment_captured',
  'fulfilled',
  'abandoned',
  'failed',
  'cancelled',
  'review',
] as const
export type CheckoutIntentStatus = (typeof CHECKOUT_INTENT_STATUSES)[number]

export interface ICheckoutQuoteSnapshot {
  currency: 'INR'
  listPricePaise: InrPaise
  discountPaise: InrPaise
  payablePaise: InrPaise
  renewalPricePaise?: InrPaise
  subscriptionTotalCount?: number
  discountedBillingCycles?: number
  couponCampaignId?: mongoose.Types.ObjectId
  couponCampaignRevision?: number
  gst: {
    inclusive: true
    rateBps: typeof INDIA_GST_RATE_BPS
    componentAllocation: 'unallocated'
  }
  entitlementSnapshot: unknown
}

export interface ICheckoutIntent extends Document {
  userId: mongoose.Types.ObjectId
  kind: CheckoutIntentKind
  providerMode: ProviderMode
  purpose?: CheckoutIntentPurpose
  planChangeRequestId?: mongoose.Types.ObjectId
  leaseLane?: ConsumerSubscriptionLeaseLane
  requestedStartAt?: Date
  authorizationExpiresAt?: Date
  planKey?: 'plus' | 'pro'
  sku?: 'single_interview' | 'premium_resume'
  catalogVersion: string
  idempotencyKey: string
  requestHash: string
  quoteSnapshot: ICheckoutQuoteSnapshot
  buyerSnapshot: unknown
  status: CheckoutIntentStatus
  razorpaySubscriptionId?: string
  razorpayOrderId?: string
  receipt: string
  nextRecoveryAt?: Date
  remoteCreationLeaseToken?: string
  remoteCreationLeaseExpiresAt?: Date
  remoteCreationStartedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const inrPaiseValidator = {
  validator: isInrPaise,
  message: '{PATH} must be non-negative safe-integer INR paise',
}

const CheckoutGstSnapshotSchema = new Schema(
  {
    inclusive: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown): value is true => value === true,
        message: 'GST snapshot must remain inclusive',
      },
    },
    rateBps: {
      type: Number,
      enum: [INDIA_GST_RATE_BPS],
      required: true,
      immutable: true,
    },
    componentAllocation: {
      type: String,
      enum: ['unallocated'],
      required: true,
      immutable: true,
    },
  },
  { _id: false },
)

const CheckoutQuoteSnapshotSchema = new Schema<ICheckoutQuoteSnapshot>(
  {
    currency: {
      type: String,
      enum: ['INR'],
      required: true,
      immutable: true,
    },
    listPricePaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: inrPaiseValidator,
    },
    discountPaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: inrPaiseValidator,
    },
    payablePaise: {
      type: Number,
      required: true,
      immutable: true,
      validate: inrPaiseValidator,
    },
    renewalPricePaise: {
      type: Number,
      immutable: true,
      validate: inrPaiseValidator,
    },
    subscriptionTotalCount: {
      type: Number,
      min: 1,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'subscriptionTotalCount must be a positive safe integer',
      },
    },
    discountedBillingCycles: {
      type: Number,
      min: 1,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'discountedBillingCycles must be a positive safe integer',
      },
    },
    couponCampaignId: {
      type: Schema.Types.ObjectId,
      ref: 'CouponCampaign',
      immutable: true,
    },
    couponCampaignRevision: {
      type: Number,
      min: 1,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'couponCampaignRevision must be a positive safe integer',
      },
    },
    gst: {
      type: CheckoutGstSnapshotSchema,
      required: true,
      immutable: true,
    },
    entitlementSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
  },
  { _id: false },
)

CheckoutQuoteSnapshotSchema.pre(
  'validate',
  function validateQuoteArithmetic() {
    if (
      !isInrPaise(this.listPricePaise) ||
      !isInrPaise(this.discountPaise) ||
      !isInrPaise(this.payablePaise)
    ) {
      return
    }
    if (this.discountPaise > this.listPricePaise) {
      this.invalidate(
        'discountPaise',
        'discountPaise cannot exceed listPricePaise',
      )
      return
    }
    if (
      this.payablePaise !==
      this.listPricePaise - this.discountPaise
    ) {
      this.invalidate(
        'payablePaise',
        'payablePaise must equal listPricePaise minus discountPaise',
      )
    }
  },
)

const CheckoutIntentSchema = new Schema<ICheckoutIntent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    kind: {
      type: String,
      enum: CHECKOUT_INTENT_KINDS,
      required: true,
      immutable: true,
    },
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      required: true,
      immutable: true,
    },
    purpose: {
      type: String,
      enum: CHECKOUT_INTENT_PURPOSES,
      immutable: true,
    },
    planChangeRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'PlanChangeRequest',
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
    planKey: {
      type: String,
      enum: ['plus', 'pro'],
      immutable: true,
    },
    sku: {
      type: String,
      enum: ['single_interview', 'premium_resume'],
      immutable: true,
    },
    catalogVersion: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      maxlength: 200,
      immutable: true,
    },
    requestHash: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    quoteSnapshot: {
      type: CheckoutQuoteSnapshotSchema,
      required: true,
      immutable: true,
    },
    buyerSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: CHECKOUT_INTENT_STATUSES,
      required: true,
      default: 'created',
    },
    razorpaySubscriptionId: {
      type: String,
      trim: true,
    },
    razorpayOrderId: {
      type: String,
      trim: true,
    },
    receipt: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      maxlength: 40,
      immutable: true,
    },
    nextRecoveryAt: { type: Date },
    remoteCreationLeaseToken: {
      type: String,
      trim: true,
      minlength: 16,
      maxlength: 200,
    },
    remoteCreationLeaseExpiresAt: { type: Date },
    remoteCreationStartedAt: { type: Date },
  },
  { timestamps: true },
)

CheckoutIntentSchema.pre('validate', function validateCheckoutTarget() {
  const quote = this.quoteSnapshot
  const lifecycleFieldsPresent = Boolean(
    this.purpose ||
    this.planChangeRequestId ||
    this.leaseLane ||
    this.requestedStartAt ||
    this.authorizationExpiresAt,
  )
  const hasCouponCampaign = quote?.couponCampaignId !== undefined
  const hasCouponRevision = quote?.couponCampaignRevision !== undefined
  if (hasCouponCampaign !== hasCouponRevision) {
    this.invalidate(
      'quoteSnapshot.couponCampaignRevision',
      'Coupon campaign and revision must be snapshotted together',
    )
  }

  if (this.kind === 'subscription') {
    if (this.planKey !== 'plus' && this.planKey !== 'pro') {
      this.invalidate(
        'planKey',
        'Subscription checkout requires a paid planKey',
      )
    }
    if (this.sku !== undefined) {
      this.invalidate('sku', 'Subscription checkout cannot include a SKU')
    }
    if (quote?.renewalPricePaise === undefined) {
      this.invalidate(
        'quoteSnapshot.renewalPricePaise',
        'Subscription checkout requires a renewal price snapshot',
      )
    }
    if (quote?.subscriptionTotalCount === undefined) {
      this.invalidate(
        'quoteSnapshot.subscriptionTotalCount',
        'Subscription checkout requires a total count snapshot',
      )
    }
    if (
      hasCouponCampaign &&
      quote?.discountedBillingCycles === undefined
    ) {
      this.invalidate(
        'quoteSnapshot.discountedBillingCycles',
        'Coupon subscription checkout requires discounted cycle count',
      )
    }
    // Legacy dark intents have no lifecycle tuple. They remain readable for
    // activation cleanup, while remote creation fails them closed.
    if (!lifecycleFieldsPresent) return
    if (
      !this.purpose ||
      !this.leaseLane ||
      !this.authorizationExpiresAt
    ) {
      this.invalidate(
        'purpose',
        'Subscription lifecycle tuple requires purpose, lane, and authorization expiry',
      )
      return
    }
    if (this.purpose === 'acquisition') {
      const couponUpfrontLifecycle = Boolean(
        quote &&
        quote.discountPaise > 0 &&
        quote.discountedBillingCycles === 1,
      )
      if (
        this.leaseLane !== 'a' ||
        this.planChangeRequestId ||
        (
          this.requestedStartAt &&
          (
            !couponUpfrontLifecycle ||
            this.authorizationExpiresAt >= this.requestedStartAt
          )
        )
      ) {
        this.invalidate(
          'purpose',
          'Acquisition checkout lifecycle is inconsistent',
        )
      }
      return
    }
    if (!this.planChangeRequestId || !this.requestedStartAt) {
      this.invalidate(
        'planChangeRequestId',
        'Future subscription checkout requires durable plan-change lineage',
      )
      return
    }
    if (this.authorizationExpiresAt >= this.requestedStartAt) {
      this.invalidate(
        'authorizationExpiresAt',
        'Authorization expiry must precede requested subscription start',
      )
    }
    return
  }

  if (lifecycleFieldsPresent) {
    this.invalidate(
      'purpose',
      'One-time checkout cannot include subscription lifecycle fields',
    )
  }
  if (this.planKey !== undefined) {
    this.invalidate('planKey', 'One-time checkout cannot include a planKey')
  }
  if (this.sku !== this.kind) {
    this.invalidate('sku', 'sku must match the one-time checkout kind')
  }
  if (quote?.renewalPricePaise !== undefined) {
    this.invalidate(
      'quoteSnapshot.renewalPricePaise',
      'One-time checkout cannot include a renewal price',
    )
  }
  if (quote?.subscriptionTotalCount !== undefined) {
    this.invalidate(
      'quoteSnapshot.subscriptionTotalCount',
      'One-time checkout cannot include a subscription total count',
    )
  }
  if (
    quote?.discountPaise !== 0 ||
    hasCouponCampaign ||
    quote?.discountedBillingCycles !== undefined
  ) {
    this.invalidate(
      'quoteSnapshot.discountPaise',
      'One-time products are not coupon eligible',
    )
  }
})

CheckoutIntentSchema.index(
  {
    userId: 1,
    providerMode: 1,
    kind: 1,
    idempotencyKey: 1,
  },
  { unique: true },
)
CheckoutIntentSchema.index(
  { providerMode: 1, receipt: 1 },
  { unique: true },
)
CheckoutIntentSchema.index(
  { providerMode: 1, razorpayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayOrderId: { $type: 'string' },
    },
  },
)
CheckoutIntentSchema.index(
  { providerMode: 1, razorpaySubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpaySubscriptionId: { $type: 'string' },
    },
  },
)
CheckoutIntentSchema.index(
  { planChangeRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      planChangeRequestId: { $type: 'objectId' },
    },
  },
)
CheckoutIntentSchema.index({ status: 1, nextRecoveryAt: 1 })
CheckoutIntentSchema.index({ userId: 1, createdAt: -1 })

export const CheckoutIntent: Model<ICheckoutIntent> =
  mongoose.models.CheckoutIntent ||
  mongoose.model<ICheckoutIntent>('CheckoutIntent', CheckoutIntentSchema)
