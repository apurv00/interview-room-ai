import mongoose, {
  type InferSchemaType,
  type Model,
  Schema,
} from 'mongoose'
import {
  COMMERCIAL_ANALYTICS_EVENT_NAMES,
  COMMERCIAL_ANALYTICS_SCHEMA_VERSION,
  COMMERCIAL_ANALYTICS_SERVER_SOURCES,
  composeCommercialAnalyticsEventRecord,
  type CommercialAnalyticsEventInput,
} from '../types'
const DIGEST = /^[a-f0-9]{64}$/
const EVENT_ID = /^cae_[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{24}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const nonNegativeSafeInteger = {
  validator: (value: number) =>
    Number.isSafeInteger(value) && value >= 0,
  message: '{PATH} must be a non-negative safe integer',
}
const optionalToken = {
  type: String,
  required: false,
  default: null,
  immutable: true,
  trim: true,
  minlength: 1,
  maxlength: 120,
  validate: {
    validator: (value: string | null) =>
      value === null ||
      (
        value === value.trim() &&
        !CONTROL.test(value)
      ),
    message: '{PATH} must be a bounded token',
  },
}
const digestField = (nullable = false) => ({
  type: String,
  required: !nullable,
  default: nullable ? null : undefined,
  immutable: true,
  lowercase: true,
  match: DIGEST,
})
const moneyField = {
  type: Number,
  required: true,
  immutable: true,
  validate: nonNegativeSafeInteger,
}
const DimensionsSchema = new Schema(
  {
    surface: {
      type: String,
      enum: [
        'pricing',
        'checkout',
        'interview_setup',
        'interview_paywall',
        'feedback',
        'resume',
        'settings',
        'cms',
        null,
      ],
      required: false,
      default: null,
      immutable: true,
    },
    paywallReason: {
      type: String,
      enum: [
        'interview_limit',
        'duration_limit',
        'premium_resume_required',
        'subscription_inactive',
        null,
      ],
      required: false,
      default: null,
      immutable: true,
    },
    catalogVersion: optionalToken,
    pricingVariant: optionalToken,
    productKey: {
      type: String,
      enum: [
        'free',
        'plus',
        'pro',
        'single_interview',
        'premium_resume',
        null,
      ],
      required: false,
      default: null,
      immutable: true,
    },
    couponCampaignId: {
      type: String,
      required: false,
      default: null,
      immutable: true,
      lowercase: true,
      match: OBJECT_ID,
    },
    couponCampaignDigest: { ...digestField(), required: false },
    couponResult: { type: String,
      enum: ['applied', 'invalid', 'ineligible',
        'not_better_than_automatic', 'system_unavailable', null],
      default: null, immutable: true },
    couponMode: {
      type: String,
      enum: ['automatic', 'code', 'targeted', null],
      required: false,
      default: null,
      immutable: true,
    },
    eligibilitySegment: {
      type: String,
      enum: [
        'waitlist',
        'student',
        'winback',
        'partner',
        'all',
        null,
      ],
      required: false,
      default: null,
      immutable: true,
    },
    userState: {
      type: String,
      enum: ['new', 'legacy', 'grandfathered', null],
      required: false,
      default: null,
      immutable: true,
    },
    eligiblePaywall: {
      type: Boolean,
      required: true,
      immutable: true,
    },
    codeLength: {
      type: Number,
      required: false,
      default: null,
      min: 1,
      max: 64,
      immutable: true,
    },
    interviewsRemaining: {
      type: Number,
      required: false,
      default: null,
      min: 0,
      immutable: true,
      validate: nonNegativeSafeInteger,
    },
    premiumResumesRemaining: {
      type: Number,
      required: false,
      default: null,
      min: 0,
      immutable: true,
      validate: nonNegativeSafeInteger,
    },
    durationMinutes: {
      type: Number,
      enum: [10, 20, 30, null],
      required: false,
      default: null,
      immutable: true,
    },
    accessEndsAt: {
      type: Date,
      required: false,
      default: null,
      immutable: true,
    },
    firstPaidUseWithin24Hours: {
      type: Boolean,
      required: false,
      default: null,
      immutable: true,
    },
    activationKind: {
      type: String,
      enum: [
        'initial_subscription',
        'renewal',
        'one_time',
        'admin',
        null,
      ],
      required: false,
      default: null,
      immutable: true,
    },
    lifecycleStage: { ...optionalToken, default: undefined },
    lifecycleReason: { ...optionalToken, default: undefined },
    adminGrantReason: { type: String, immutable: true,
      enum: ['grant_interview', 'grant_premium_resume',
        'grant_comp_period'] },
    adminGrantQuantity: { type: Number, enum: [1], immutable: true },
  },
  { _id: false, strict: 'throw' },
)
const AmountsSchema = new Schema(
  {
    listPricePaise: moneyField,
    discountPaise: moneyField,
    payablePaise: moneyField,
    renewalPricePaise: {
      ...moneyField,
      required: false,
      default: null,
    },
    eventAmountPaise: moneyField,
    allocatedVariableCostPaise: moneyField,
  },
  { _id: false, strict: 'throw' },
)
const CommercialAnalyticsEventSchema = new Schema(
  {
    _id: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: EVENT_ID,
    },
    schemaVersion: {
      type: String,
      enum: [COMMERCIAL_ANALYTICS_SCHEMA_VERSION],
      required: true,
      immutable: true,
    },
    eventName: {
      type: String,
      enum: COMMERCIAL_ANALYTICS_EVENT_NAMES,
      required: true,
      immutable: true,
    },
    authority: {
      type: String,
      enum: ['server'],
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: COMMERCIAL_ANALYTICS_SERVER_SOURCES,
      required: true,
      immutable: true,
    },
    sourceEvidenceDigest: digestField(),
    correlationDigest: digestField(),
    subjectDigest: digestField(true),
    providerMode: {
      type: String,
      enum: ['test', 'live'],
      required: true,
      immutable: true,
    },
    occurredAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    dimensions: {
      type: DimensionsSchema,
      required: true,
      immutable: true,
    },
    amounts: {
      type: AmountsSchema,
      required: true,
      immutable: true,
    },
    eventDigest: digestField(),
  },
  {
    collection: 'payment_commercial_analytics_events',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)
CommercialAnalyticsEventSchema.pre(
  'validate',
  function validateCanonicalCommercialAnalyticsEvidence() {
    try {
      const persisted = this.toObject() as unknown as {
        dimensions: Omit<
          CommercialAnalyticsEventInput['dimensions'],
          'accessEndsAt'
        > & {
          accessEndsAt: Date | string | null
        }
        amounts: CommercialAnalyticsEventInput['amounts']
      }
      const dimensions = persisted.dimensions
      const accessEndsAt =
        dimensions.accessEndsAt instanceof Date
          ? dimensions.accessEndsAt.toISOString()
          : dimensions.accessEndsAt
      const expected = composeCommercialAnalyticsEventRecord({
        schemaVersion: this.schemaVersion,
        eventName: this.eventName,
        authority: this.authority,
        source: this.source,
        sourceEvidenceDigest: this.sourceEvidenceDigest,
        correlationDigest: this.correlationDigest,
        subjectDigest: this.subjectDigest ?? null,
        providerMode: this.providerMode,
        occurredAt: this.occurredAt.toISOString(),
        dimensions: { ...dimensions, accessEndsAt },
        amounts: persisted.amounts,
      })
      if (
        this._id !== expected.eventId ||
        this.eventDigest !== expected.eventDigest
      ) {
        this.invalidate(
          'eventDigest',
          'Commercial analytics identity must bind canonical evidence',
        )
      }
    } catch {
      this.invalidate(
        'eventDigest',
        'Commercial analytics evidence is not canonical',
      )
    }
  },
)
CommercialAnalyticsEventSchema.index(
  { sourceEvidenceDigest: 1, eventName: 1 },
  { unique: true },
)
CommercialAnalyticsEventSchema.index({
  providerMode: 1,
  occurredAt: -1,
  eventName: 1,
})
CommercialAnalyticsEventSchema.index({
  providerMode: 1,
  correlationDigest: 1,
  occurredAt: 1,
})
CommercialAnalyticsEventSchema.index({
  providerMode: 1,
  subjectDigest: 1,
  occurredAt: -1,
})
CommercialAnalyticsEventSchema.index({
  providerMode: 1,
  'dimensions.couponCampaignId': 1,
  occurredAt: -1,
})
function rejectCommercialAnalyticsMutation(): never {
  throw new Error('Commercial analytics events are append-only')
}
CommercialAnalyticsEventSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
  ],
  { query: true, document: false },
  rejectCommercialAnalyticsMutation,
)
CommercialAnalyticsEventSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  rejectCommercialAnalyticsMutation,
)
CommercialAnalyticsEventSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectCommercialAnalyticsMutation,
)
CommercialAnalyticsEventSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectCommercialAnalyticsMutation,
)
CommercialAnalyticsEventSchema.pre(
  'bulkWrite',
  rejectCommercialAnalyticsMutation,
)
CommercialAnalyticsEventSchema.pre(
  'save',
  function rejectExistingCommercialAnalyticsSave() {
    if (!this.isNew) rejectCommercialAnalyticsMutation()
  },
)
export type CommercialAnalyticsEventDocument =
  InferSchemaType<typeof CommercialAnalyticsEventSchema>
export const CommercialAnalyticsEvent:
  Model<CommercialAnalyticsEventDocument> =
    (
      mongoose.models.CommercialAnalyticsEvent as
        Model<CommercialAnalyticsEventDocument> | undefined
    ) ??
    mongoose.model<CommercialAnalyticsEventDocument>(
      'CommercialAnalyticsEvent',
      CommercialAnalyticsEventSchema,
    )
