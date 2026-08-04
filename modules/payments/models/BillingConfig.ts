import mongoose, { Document, Model, Schema } from 'mongoose'

export const SELLING_MODES = ['off', 'qa', 'all'] as const
export const ENFORCEMENT_MODES = ['off', 'shadow', 'new_users', 'all'] as const
export const COUPON_MODES = ['off', 'qa', 'all'] as const
export const BILLING_COHORT_ALGORITHMS = ['sha256-v1'] as const

export type SellingMode = (typeof SELLING_MODES)[number]
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number]
export type CouponMode = (typeof COUPON_MODES)[number]
export type BillingCohortAlgorithm =
  (typeof BILLING_COHORT_ALGORITHMS)[number]

export interface BillingRolloutSurfaces {
  selling: boolean
  enforcement: boolean
  copy: boolean
  analytics: boolean
  communications: boolean
}

export interface BillingRolloutPolicy {
  version: 1
  algorithm: BillingCohortAlgorithm
  seedId: string
  policyHash: string
  surfaces: BillingRolloutSurfaces
}

export interface IBillingConfig extends Document {
  key: 'singleton'
  revision: number
  sellingMode: SellingMode
  enforcementMode: EnforcementMode
  couponMode: CouponMode
  qaUserIds: mongoose.Types.ObjectId[]
  newUserRolloutPercent: number
  enforcementStartedAt?: Date
  legacyGrandfatherEndsAt?: Date
  activeCatalogVersion?: string
  autoCouponRequired: boolean
  webhookProcessingEnabled: boolean
  reconciliationEnabled: boolean
  rolloutPolicy?: BillingRolloutPolicy
  updatedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const BillingRolloutSurfacesSchema = new Schema<BillingRolloutSurfaces>(
  {
    selling: { type: Boolean, required: true, default: false },
    enforcement: { type: Boolean, required: true, default: false },
    copy: { type: Boolean, required: true, default: false },
    analytics: { type: Boolean, required: true, default: false },
    communications: { type: Boolean, required: true, default: false },
  },
  { _id: false, strict: 'throw' },
)

const BillingRolloutPolicySchema = new Schema<BillingRolloutPolicy>(
  {
    version: { type: Number, required: true, enum: [1] },
    algorithm: {
      type: String,
      required: true,
      enum: BILLING_COHORT_ALGORITHMS,
    },
    seedId: {
      type: String,
      required: true,
      minlength: 3,
      maxlength: 128,
      match: /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    },
    policyHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    surfaces: {
      type: BillingRolloutSurfacesSchema,
      required: true,
      default: () => ({}),
    },
  },
  { _id: false, strict: 'throw' },
)

const BillingConfigSchema = new Schema<IBillingConfig>(
  {
    key: {
      type: String,
      enum: ['singleton'],
      required: true,
      default: 'singleton',
    },
    revision: { type: Number, required: true, min: 0, default: 0 },
    sellingMode: { type: String, enum: SELLING_MODES, default: 'off' },
    enforcementMode: {
      type: String,
      enum: ENFORCEMENT_MODES,
      default: 'off',
    },
    couponMode: { type: String, enum: COUPON_MODES, default: 'off' },
    qaUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    newUserRolloutPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    enforcementStartedAt: { type: Date },
    legacyGrandfatherEndsAt: { type: Date },
    activeCatalogVersion: { type: String },
    autoCouponRequired: { type: Boolean, default: true },
    webhookProcessingEnabled: { type: Boolean, default: false },
    reconciliationEnabled: { type: Boolean, default: false },
    rolloutPolicy: { type: BillingRolloutPolicySchema },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

BillingConfigSchema.index({ key: 1 }, { unique: true })

export const BillingConfig: Model<IBillingConfig> =
  mongoose.models.BillingConfig ||
  mongoose.model<IBillingConfig>('BillingConfig', BillingConfigSchema)
