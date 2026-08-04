import mongoose, { Document, Model, Schema } from 'mongoose'

export const INTERVIEW_USAGE_SOURCES = [
  'free_period',
  'subscription_cycle',
  'subscription_grace',
  'paid_interview',
  'admin',
] as const
export type InterviewUsageSource =
  (typeof INTERVIEW_USAGE_SOURCES)[number]

export const INTERVIEW_USAGE_RESTORATION_DISPOSITIONS = [
  'restored',
  'available',
  'expired',
] as const
export type InterviewUsageRestorationDisposition =
  (typeof INTERVIEW_USAGE_RESTORATION_DISPOSITIONS)[number]

export const INTERVIEW_USAGE_AUTHORITY_ENVELOPE_VERSION = 1 as const

export interface IInterviewUsageCounterEpochV1 {
  epochId: string
  epochNumber: number
}

export interface IInterviewUsageAuthorityEnvelopeV1 {
  version: typeof INTERVIEW_USAGE_AUTHORITY_ENVELOPE_VERSION
  adminGrantId?: string
  counterEpoch?: IInterviewUsageCounterEpochV1
}

export const NORMALIZED_INTERVIEW_DURATIONS_MINUTES = [
  10,
  20,
  30,
] as const
export type NormalizedInterviewDurationMinutes =
  (typeof NORMALIZED_INTERVIEW_DURATIONS_MINUTES)[number]

export interface IInterviewUsage extends Document {
  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  source: InterviewUsageSource
  sourceId: mongoose.Types.ObjectId
  periodKey?: string
  reservedAt: Date
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  restorationDisposition?: InterviewUsageRestorationDisposition
  normalizedDurationMinutes: NormalizedInterviewDurationMinutes
  entitlementSnapshot: unknown
  entitlementSnapshotDigest?: string
  authorityEnvelope?: IInterviewUsageAuthorityEnvelopeV1
  createdAt: Date
  updatedAt: Date
}

const AUTHORITY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

const InterviewUsageCounterEpochV1Schema =
  new Schema<IInterviewUsageCounterEpochV1>(
    {
      epochId: {
        type: String,
        required: true,
        trim: true,
        minlength: 8,
        maxlength: 200,
        match: AUTHORITY_ID_PATTERN,
      },
      epochNumber: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
    },
    { _id: false },
  )

const InterviewUsageAuthorityEnvelopeV1Schema =
  new Schema<IInterviewUsageAuthorityEnvelopeV1>(
    {
      version: {
        type: Number,
        enum: [INTERVIEW_USAGE_AUTHORITY_ENVELOPE_VERSION],
        required: true,
        immutable: true,
      },
      adminGrantId: {
        type: String,
        trim: true,
        minlength: 8,
        maxlength: 200,
        match: AUTHORITY_ID_PATTERN,
      },
      counterEpoch: {
        type: InterviewUsageCounterEpochV1Schema,
      },
    },
    { _id: false },
  )

const InterviewUsageSchema = new Schema<IInterviewUsage>(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: INTERVIEW_USAGE_SOURCES,
      required: true,
      immutable: true,
    },
    sourceId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    periodKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    reservedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    consumedAt: { type: Date },
    restorationId: {
      type: Schema.Types.ObjectId,
    },
    restorationDisposition: {
      type: String,
      enum: INTERVIEW_USAGE_RESTORATION_DISPOSITIONS,
    },
    normalizedDurationMinutes: {
      type: Number,
      enum: NORMALIZED_INTERVIEW_DURATIONS_MINUTES,
      required: true,
      immutable: true,
    },
    entitlementSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    entitlementSnapshotDigest: {
      type: String,
      trim: true,
      lowercase: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    authorityEnvelope: {
      type: InterviewUsageAuthorityEnvelopeV1Schema,
      default: undefined,
      immutable: true,
    },
  },
  { timestamps: true },
)

InterviewUsageSchema.pre('validate', function validateUsageLinkage() {
  const periodLinked =
    this.source === 'free_period' ||
    this.source === 'subscription_cycle' ||
    this.source === 'subscription_grace'

  if (periodLinked && !this.periodKey) {
    this.invalidate(
      'periodKey',
      'Period-backed interview usage requires periodKey',
    )
  }

  if (
    this.source === 'free_period' &&
    this.normalizedDurationMinutes !== 10
  ) {
    this.invalidate(
      'normalizedDurationMinutes',
      'Basic free-period interviews are limited to 10 minutes',
    )
  }

  if (this.consumedAt && this.consumedAt < this.reservedAt) {
    this.invalidate(
      'consumedAt',
      'consumedAt cannot precede reservedAt',
    )
  }

  if (
    this.restorationId &&
    !this.consumedAt &&
    (
      this.source !== 'paid_interview' ||
      !this.entitlementSnapshotDigest
    )
  ) {
    this.invalidate(
      'restorationId',
      'Restoration linkage requires a consumed usage',
    )
  }

  if (
    this.restorationDisposition !== undefined &&
    !this.restorationId
  ) {
    this.invalidate(
      'restorationDisposition',
      'Restoration disposition requires restoration linkage',
    )
  }

  if (
    this.source === 'admin' &&
    this.restorationId &&
    this.restorationDisposition === undefined
  ) {
    this.invalidate(
      'restorationDisposition',
      'Admin restoration linkage requires its original disposition',
    )
  }

  if (
    this.source === 'subscription_grace' &&
    this.restorationId
  ) {
    this.invalidate(
      'restorationId',
      'Subscription grace usage cannot be restored automatically',
    )
  }

  if (
    this.source !== 'admin' &&
    this.restorationDisposition !== undefined
  ) {
    this.invalidate(
      'restorationDisposition',
      'Only admin usage persists a restoration disposition',
    )
  }

  const authority = this.authorityEnvelope
  if (!authority) return

  const adminOwned = this.source === 'admin'
  if (
    adminOwned !== (authority.adminGrantId !== undefined)
  ) {
    this.invalidate(
      'authorityEnvelope.adminGrantId',
      'Versioned admin usage requires exact grant lineage',
    )
  }

  const counterOwned =
    this.source === 'free_period' ||
    this.source === 'subscription_cycle' ||
    (adminOwned && this.periodKey !== undefined)
  if (
    counterOwned !== (authority.counterEpoch !== undefined)
  ) {
    this.invalidate(
      'authorityEnvelope.counterEpoch',
      'Versioned period usage requires exactly one counter epoch',
    )
  }

  if (
    adminOwned &&
    this.periodKey !== undefined &&
    authority.adminGrantId !== undefined &&
    this.periodKey !== `admin-comp:${authority.adminGrantId}`
  ) {
    this.invalidate(
      'periodKey',
      'Versioned admin comp usage requires its exact grant period',
    )
  }

  if (
    this.source === 'paid_interview' &&
    this.periodKey !== undefined
  ) {
    this.invalidate(
      'periodKey',
      'Versioned paid interview usage cannot carry a period',
    )
  }
})

InterviewUsageSchema.index({ sessionId: 1 }, { unique: true })
InterviewUsageSchema.index(
  { restorationId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      restorationId: { $type: 'objectId' },
    },
  },
)
InterviewUsageSchema.index({ userId: 1, periodKey: 1, reservedAt: -1 })
InterviewUsageSchema.index({ source: 1, sourceId: 1 })
InterviewUsageSchema.index(
  { source: 1, sourceId: 1 },
  {
    unique: true,
    name: 'uq_interview_usage_subscription_grace_grant_v1',
    partialFilterExpression: {
      source: 'subscription_grace',
    },
  },
)
InterviewUsageSchema.index({
  userId: 1,
  source: 1,
  'authorityEnvelope.adminGrantId': 1,
  reservedAt: -1,
})
InterviewUsageSchema.index({
  source: 1,
  periodKey: 1,
  'authorityEnvelope.counterEpoch.epochId': 1,
})

export const InterviewUsage: Model<IInterviewUsage> =
  mongoose.models.InterviewUsage ||
  mongoose.model<IInterviewUsage>(
    'InterviewUsage',
    InterviewUsageSchema,
  )
