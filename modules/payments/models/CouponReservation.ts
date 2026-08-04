import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  COUPON_CAMPAIGN_MODES,
  PROVIDER_MODES,
  type CouponCampaignMode,
  type ProviderMode,
} from '../types/catalog'

export const COUPON_RESERVATION_STATUSES = [
  'reserved',
  'converted',
  'released',
  'expired',
  'review',
] as const
export type CouponReservationStatus =
  (typeof COUPON_RESERVATION_STATUSES)[number]

export const COUPON_CAPACITY_DISPOSITIONS = [
  'held',
  'converted',
  'released',
] as const
export type CouponCapacityDisposition =
  (typeof COUPON_CAPACITY_DISPOSITIONS)[number]

export const COUPON_CAPACITY_CONVERSION_SOURCES = [
  'future_subscription_authorization',
] as const
export type CouponCapacityConversionSource =
  (typeof COUPON_CAPACITY_CONVERSION_SOURCES)[number]

export const COUPON_TERMINAL_EVIDENCE_SOURCES = [
  'provider_fetch',
  'signed_webhook',
  'reconciliation',
  'local_database',
] as const
export type CouponTerminalEvidenceSource =
  (typeof COUPON_TERMINAL_EVIDENCE_SOURCES)[number]

export const COUPON_TERMINAL_REASONS = [
  'checkout_cancelled_before_remote_creation',
  'provider_subscription_cancelled_unpaid',
  'provider_subscription_completed_unpaid',
  'provider_subscription_expired_unpaid',
  'provider_order_expired_unpaid',
  'provider_payment_failed_terminal',
  'reconciliation_timeout',
  'local_intent_expired_without_remote_object',
] as const
export type CouponTerminalReason =
  (typeof COUPON_TERMINAL_REASONS)[number]

export const COUPON_RESERVATION_REVIEW_REASONS = [
  'ambiguous_remote_state',
  'capacity_fence_drift',
  'late_capture_after_release',
  'late_capture_after_expiry',
  'redemption_cycle_conflict',
  'payment_identity_conflict',
  'operator_review',
] as const
export type CouponReservationReviewReason =
  (typeof COUPON_RESERVATION_REVIEW_REASONS)[number]

export interface ICouponReservation extends Document {
  providerMode: ProviderMode
  campaignId: mongoose.Types.ObjectId
  campaignRevision: number
  userId: mongoose.Types.ObjectId
  checkoutIntentId: mongoose.Types.ObjectId
  catalogVersion: string
  planKey: 'plus' | 'pro'
  campaignModeSnapshot: CouponCampaignMode
  codeSnapshot?: string
  discountPaise: number
  discountedBillingCycles: number
  maxRedemptionsSnapshot?: number
  maxRedemptionsPerUserSnapshot: number
  reservationTtlHoursSnapshot: number
  status: CouponReservationStatus
  capacityDisposition: CouponCapacityDisposition
  reservedAt: Date
  validUntil: Date
  convertedAt?: Date
  capacityConversionSource?: CouponCapacityConversionSource
  conversionProviderSubscriptionId?: string
  conversionProviderPaymentId?: string
  terminalAt?: Date
  terminalReason?: CouponTerminalReason
  terminalEvidenceSource?: CouponTerminalEvidenceSource
  terminalEvidenceKey?: string
  terminalObservedAt?: Date
  reviewReason?: CouponReservationReviewReason
  reviewEvidenceKey?: string
  createdAt: Date
  updatedAt: Date
}

const CouponReservationSchema = new Schema<ICouponReservation>(
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
    catalogVersion: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
      immutable: true,
    },
    planKey: {
      type: String,
      enum: ['plus', 'pro'],
      required: true,
      immutable: true,
    },
    campaignModeSnapshot: {
      type: String,
      enum: COUPON_CAMPAIGN_MODES,
      required: true,
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
    discountedBillingCycles: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    maxRedemptionsSnapshot: {
      type: Number,
      min: 1,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    maxRedemptionsPerUserSnapshot: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    reservationTtlHoursSnapshot: {
      type: Number,
      required: true,
      min: 1,
      max: 168,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    status: {
      type: String,
      enum: COUPON_RESERVATION_STATUSES,
      default: 'reserved',
      required: true,
    },
    capacityDisposition: {
      type: String,
      enum: COUPON_CAPACITY_DISPOSITIONS,
      default: 'held',
      required: true,
    },
    reservedAt: { type: Date, required: true, default: Date.now },
    validUntil: { type: Date, required: true },
    convertedAt: { type: Date },
    capacityConversionSource: {
      type: String,
      enum: COUPON_CAPACITY_CONVERSION_SOURCES,
      immutable: true,
    },
    conversionProviderSubscriptionId: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    conversionProviderPaymentId: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    terminalAt: { type: Date },
    terminalReason: {
      type: String,
      enum: COUPON_TERMINAL_REASONS,
    },
    terminalEvidenceSource: {
      type: String,
      enum: COUPON_TERMINAL_EVIDENCE_SOURCES,
    },
    terminalEvidenceKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
    },
    terminalObservedAt: { type: Date },
    reviewReason: {
      type: String,
      enum: COUPON_RESERVATION_REVIEW_REASONS,
    },
    reviewEvidenceKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
    },
  },
  { timestamps: true },
)

CouponReservationSchema.index(
  { providerMode: 1, checkoutIntentId: 1 },
  { unique: true },
)
CouponReservationSchema.index({ checkoutIntentId: 1 }, { unique: true })
CouponReservationSchema.index({
  providerMode: 1,
  campaignId: 1,
  userId: 1,
  capacityDisposition: 1,
  reservedAt: -1,
})
CouponReservationSchema.index({
  providerMode: 1,
  status: 1,
  capacityDisposition: 1,
  validUntil: 1,
  _id: 1,
})

CouponReservationSchema.pre('validate', function validateReservationState() {
  if (
    (this.campaignModeSnapshot === 'code' && !this.codeSnapshot) ||
    (this.campaignModeSnapshot !== 'code' && this.codeSnapshot !== undefined)
  ) {
    this.invalidate(
      'codeSnapshot',
      'Coupon code snapshot must exist only for code campaigns',
    )
  }
  if (this.validUntil <= this.reservedAt) {
    this.invalidate('validUntil', 'validUntil must be after reservedAt')
  }
  if (this.status === 'reserved' && this.capacityDisposition !== 'held') {
    this.invalidate(
      'capacityDisposition',
      'Reserved coupon capacity must remain held',
    )
  }
  if (
    this.status === 'converted' &&
    (this.capacityDisposition !== 'converted' || !this.convertedAt)
  ) {
    this.invalidate(
      'convertedAt',
      'Converted reservations require converted capacity and a timestamp',
    )
  }
  if (
    (this.status === 'released' || this.status === 'expired') &&
    (
      this.capacityDisposition !== 'released' ||
      !this.terminalAt ||
      !this.terminalReason ||
      !this.terminalEvidenceSource ||
      !this.terminalEvidenceKey ||
      !this.terminalObservedAt
    )
  ) {
    this.invalidate(
      'terminalEvidenceKey',
      'Terminal reservations require proven release evidence',
    )
  }
  if (
    (this.status === 'released' || this.status === 'expired') &&
    this.terminalEvidenceSource === 'local_database'
  ) {
    this.invalidate(
      'terminalEvidenceSource',
      'Local absence is not proof of a terminal provider state',
    )
  }
  if (this.status === 'review' && !this.reviewReason) {
    this.invalidate('reviewReason', 'Review reservations require a reason')
  }
  if (
    this.capacityDisposition === 'converted' &&
    !this.convertedAt
  ) {
    this.invalidate(
      'convertedAt',
      'Converted capacity requires a conversion timestamp',
    )
  }
  const authorizationEvidenceCount = [
    this.capacityConversionSource,
    this.conversionProviderSubscriptionId,
    this.conversionProviderPaymentId,
  ].filter(Boolean).length
  if (
    authorizationEvidenceCount !== 0 &&
    (
      authorizationEvidenceCount !== 3 ||
      this.capacityConversionSource !==
        'future_subscription_authorization' ||
      this.capacityDisposition !== 'converted' ||
      !this.convertedAt
    )
  ) {
    this.invalidate(
      'capacityConversionSource',
      'Future authorization conversion evidence must be complete',
    )
  }
})

export const CouponReservation: Model<ICouponReservation> =
  mongoose.models.CouponReservation ||
  mongoose.model<ICouponReservation>(
    'CouponReservation',
    CouponReservationSchema,
  )
