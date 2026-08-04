import mongoose, { Document, Model, Schema } from 'mongoose'

export const ADMIN_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION = 1 as const
export const ADMIN_ENTITLEMENT_INTERVIEW_QUANTITY = 1 as const
export const ADMIN_ENTITLEMENT_INTERVIEW_MAX_DURATION_MINUTES = 30 as const
export const ADMIN_ENTITLEMENT_ONE_TIME_MAX_VALIDITY_DAYS = 30 as const
export const ADMIN_ENTITLEMENT_COMP_MAX_VALIDITY_DAYS = 90 as const

const DAY_MS = 24 * 60 * 60 * 1000

export const ADMIN_ENTITLEMENT_PROJECTION_KINDS = [
  'interview',
  'comp_period',
] as const
export type AdminEntitlementProjectionKind =
  (typeof ADMIN_ENTITLEMENT_PROJECTION_KINDS)[number]

export const ADMIN_ENTITLEMENT_LIFECYCLE_STATES = [
  'scheduled',
  'active',
  'suspended_paid',
  'expired',
  'revoked',
  'review',
] as const
export type AdminEntitlementLifecycleState =
  (typeof ADMIN_ENTITLEMENT_LIFECYCLE_STATES)[number]

export const ADMIN_INTERVIEW_OPERATIONAL_STATES = [
  'available',
  'consumed',
  'restored',
] as const
export type AdminInterviewOperationalState =
  (typeof ADMIN_INTERVIEW_OPERATIONAL_STATES)[number]

export interface IAdminCounterEpochV1 {
  epochId: string
  epochNumber: number
}

export interface IAdminEntitlementAuthorityEnvelopeV1 {
  version: typeof ADMIN_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION
  interviewCounterEpoch?: IAdminCounterEpochV1
  premiumResumeCounterEpoch?: IAdminCounterEpochV1
}

export interface IDisplacedBasicEntitlementProjectionV1 {
  periodKey: string
  interviewsUsed: number
  interviewLimit: number
  premiumResumesUsed: number
  premiumResumeLimit: number
  usageResetAt: Date
  entitlementVersion: number
  interviewCounterEpoch: IAdminCounterEpochV1
  premiumResumeCounterEpoch: IAdminCounterEpochV1
}

export interface IAdminEntitlementProjection extends Document {
  userId: mongoose.Types.ObjectId
  grantId: string
  kind: AdminEntitlementProjectionKind
  grantVersion: number
  authorityEnvelope: IAdminEntitlementAuthorityEnvelopeV1
  startsAt: Date
  endsAt: Date
  revokeEffectiveAt?: Date
  lifecycleState: AdminEntitlementLifecycleState

  quantity?: typeof ADMIN_ENTITLEMENT_INTERVIEW_QUANTITY
  interviewTypeScope?: 'any'
  maxDurationMinutes?:
    typeof ADMIN_ENTITLEMENT_INTERVIEW_MAX_DURATION_MINUTES
  interviewState?: AdminInterviewOperationalState
  consumedSessionId?: mongoose.Types.ObjectId
  consumedUsageId?: mongoose.Types.ObjectId
  consumedAt?: Date
  restorationId?: mongoose.Types.ObjectId
  restoredAt?: Date

  planKey?: 'plus' | 'pro'
  periodKey?: string
  catalogVersion?: string
  catalogContentHash?: string
  interviewLimitSnapshot?: number
  premiumResumeLimitSnapshot?: number
  interviewsUsed?: number
  premiumResumesUsed?: number
  displacedBasicProjection?:
    IDisplacedBasicEntitlementProjectionV1

  createdAt: Date
  updatedAt: Date
}

const OPERATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

const positiveSafeInteger = {
  validator: (value: number) =>
    Number.isSafeInteger(value) && value >= 1,
  message: 'Value must be a positive safe integer',
}

const nonNegativeSafeInteger = {
  validator: (value: number) =>
    Number.isSafeInteger(value) && value >= 0,
  message: 'Value must be a non-negative safe integer',
}

const AdminCounterEpochSchema =
  new Schema<IAdminCounterEpochV1>(
    {
      epochId: {
        type: String,
        required: true,
        trim: true,
        minlength: 8,
        maxlength: 200,
        match: OPERATION_ID_PATTERN,
      },
      epochNumber: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
    },
    { _id: false },
  )

const AdminEntitlementAuthorityEnvelopeSchema =
  new Schema<IAdminEntitlementAuthorityEnvelopeV1>(
    {
      version: {
        type: Number,
        enum: [ADMIN_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION],
        required: true,
        immutable: true,
      },
      interviewCounterEpoch: {
        type: AdminCounterEpochSchema,
      },
      premiumResumeCounterEpoch: {
        type: AdminCounterEpochSchema,
      },
    },
    { _id: false },
  )

const DisplacedBasicEntitlementProjectionSchema =
  new Schema<IDisplacedBasicEntitlementProjectionV1>(
    {
      periodKey: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 255,
      },
      interviewsUsed: {
        type: Number,
        required: true,
        validate: nonNegativeSafeInteger,
      },
      interviewLimit: {
        type: Number,
        required: true,
        validate: nonNegativeSafeInteger,
      },
      premiumResumesUsed: {
        type: Number,
        required: true,
        validate: nonNegativeSafeInteger,
      },
      premiumResumeLimit: {
        type: Number,
        required: true,
        validate: nonNegativeSafeInteger,
      },
      usageResetAt: {
        type: Date,
        required: true,
      },
      entitlementVersion: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
      interviewCounterEpoch: {
        type: AdminCounterEpochSchema,
        required: true,
      },
      premiumResumeCounterEpoch: {
        type: AdminCounterEpochSchema,
        required: true,
      },
    },
    { _id: false },
  )

const AdminEntitlementProjectionSchema =
  new Schema<IAdminEntitlementProjection>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
      },
      grantId: {
        type: String,
        required: true,
        trim: true,
        minlength: 8,
        maxlength: 200,
        match: OPERATION_ID_PATTERN,
        immutable: true,
      },
      kind: {
        type: String,
        enum: ADMIN_ENTITLEMENT_PROJECTION_KINDS,
        required: true,
        immutable: true,
      },
      grantVersion: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
      authorityEnvelope: {
        type: AdminEntitlementAuthorityEnvelopeSchema,
        required: true,
      },
      startsAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      endsAt: {
        type: Date,
        required: true,
      },
      revokeEffectiveAt: {
        type: Date,
      },
      lifecycleState: {
        type: String,
        enum: ADMIN_ENTITLEMENT_LIFECYCLE_STATES,
        required: true,
      },

      quantity: {
        type: Number,
        enum: [ADMIN_ENTITLEMENT_INTERVIEW_QUANTITY],
        immutable: true,
      },
      interviewTypeScope: {
        type: String,
        enum: ['any'],
        immutable: true,
      },
      maxDurationMinutes: {
        type: Number,
        enum: [ADMIN_ENTITLEMENT_INTERVIEW_MAX_DURATION_MINUTES],
        immutable: true,
      },
      interviewState: {
        type: String,
        enum: ADMIN_INTERVIEW_OPERATIONAL_STATES,
      },
      consumedSessionId: {
        type: Schema.Types.ObjectId,
        ref: 'InterviewSession',
      },
      consumedUsageId: {
        type: Schema.Types.ObjectId,
        ref: 'InterviewUsage',
      },
      consumedAt: {
        type: Date,
      },
      restorationId: {
        type: Schema.Types.ObjectId,
      },
      restoredAt: {
        type: Date,
      },

      planKey: {
        type: String,
        enum: ['plus', 'pro'],
        immutable: true,
      },
      periodKey: {
        type: String,
        trim: true,
        minlength: 1,
        maxlength: 255,
        immutable: true,
      },
      catalogVersion: {
        type: String,
        trim: true,
        minlength: 1,
        maxlength: 100,
        immutable: true,
      },
      catalogContentHash: {
        type: String,
        trim: true,
        lowercase: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      interviewLimitSnapshot: {
        type: Number,
        validate: nonNegativeSafeInteger,
        immutable: true,
      },
      premiumResumeLimitSnapshot: {
        type: Number,
        validate: nonNegativeSafeInteger,
        immutable: true,
      },
      interviewsUsed: {
        type: Number,
        validate: nonNegativeSafeInteger,
      },
      premiumResumesUsed: {
        type: Number,
        validate: nonNegativeSafeInteger,
      },
      displacedBasicProjection: {
        type: DisplacedBasicEntitlementProjectionSchema,
      },
    },
    { timestamps: true },
  )

function completeEvidence(values: readonly unknown[]): boolean {
  return values.every((value) => value !== undefined)
}

function absentEvidence(values: readonly unknown[]): boolean {
  return values.every((value) => value === undefined)
}

AdminEntitlementProjectionSchema.pre(
  'validate',
  function validateAdminEntitlementProjection() {
    if (!this.authorityEnvelope) {
      this.invalidate(
        'authorityEnvelope',
        'Admin entitlement requires a versioned authority envelope',
      )
      return
    }
    if (!this.startsAt || !this.endsAt) return

    if (this.endsAt <= this.startsAt) {
      this.invalidate(
        'endsAt',
        'Admin entitlement end must be after its start',
      )
    }
    if (
      this.revokeEffectiveAt &&
      this.revokeEffectiveAt < this.startsAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Admin entitlement revocation cannot precede its start',
      )
    }
    if (
      this.revokeEffectiveAt &&
      this.revokeEffectiveAt > this.endsAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Admin entitlement revocation cannot follow its end',
      )
    }
    if (
      this.lifecycleState === 'revoked' &&
      !this.revokeEffectiveAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Revoked admin entitlement requires revocation evidence',
      )
    }

    const interviewFields = [
      this.quantity,
      this.interviewTypeScope,
      this.maxDurationMinutes,
      this.interviewState,
    ]
    const consumptionFields = [
      this.consumedSessionId,
      this.consumedUsageId,
      this.consumedAt,
    ]
    const restorationFields = [
      this.restorationId,
      this.restoredAt,
    ]
    const compFields = [
      this.planKey,
      this.periodKey,
      this.catalogVersion,
      this.catalogContentHash,
      this.interviewLimitSnapshot,
      this.premiumResumeLimitSnapshot,
      this.interviewsUsed,
      this.premiumResumesUsed,
    ]

    if (this.kind === 'interview') {
      if (
        this.endsAt.getTime() - this.startsAt.getTime() >
        ADMIN_ENTITLEMENT_ONE_TIME_MAX_VALIDITY_DAYS * DAY_MS
      ) {
        this.invalidate(
          'endsAt',
          'Admin interview redemption cannot exceed 30 days',
        )
      }
      if (
        !completeEvidence(interviewFields) ||
        this.quantity !== ADMIN_ENTITLEMENT_INTERVIEW_QUANTITY ||
        this.interviewTypeScope !== 'any' ||
        this.maxDurationMinutes !==
          ADMIN_ENTITLEMENT_INTERVIEW_MAX_DURATION_MINUTES
      ) {
        this.invalidate(
          'interviewState',
          'Admin interview authority requires one any-type max-30-minute interview',
        )
      }
      if (
        !absentEvidence(compFields) ||
        this.displacedBasicProjection !== undefined ||
        this.authorityEnvelope.interviewCounterEpoch !== undefined ||
        this.authorityEnvelope.premiumResumeCounterEpoch !== undefined
      ) {
        this.invalidate(
          'kind',
          'Admin interview authority cannot carry comp-period state',
        )
      }
      if (this.lifecycleState === 'suspended_paid') {
        this.invalidate(
          'lifecycleState',
          'Only a comp period can be suspended by paid authority',
        )
      }

      if (
        this.interviewState === 'available' &&
        (
          !absentEvidence(consumptionFields) ||
          !absentEvidence(restorationFields)
        )
      ) {
        this.invalidate(
          'interviewState',
          'Available admin interview authority cannot carry consumption evidence',
        )
      }
      if (
        this.interviewState === 'consumed' &&
        (
          !completeEvidence(consumptionFields) ||
          !absentEvidence(restorationFields)
        )
      ) {
        this.invalidate(
          'consumedAt',
          'Consumed admin interview authority requires exact consumption evidence',
        )
      }
      if (
        this.interviewState === 'restored' &&
        (
          !completeEvidence(consumptionFields) ||
          !completeEvidence(restorationFields)
        )
      ) {
        this.invalidate(
          'restoredAt',
          'Restored admin interview authority requires consumption and restoration evidence',
        )
      }
      if (
        this.consumedAt &&
        (
          this.consumedAt < this.startsAt ||
          this.consumedAt >= this.endsAt
        )
      ) {
        this.invalidate(
          'consumedAt',
          'Admin interview consumption must occur inside its grant interval',
        )
      }
      if (
        this.consumedAt &&
        this.restoredAt &&
        this.restoredAt < this.consumedAt
      ) {
        this.invalidate(
          'restoredAt',
          'Admin interview restoration cannot precede consumption',
        )
      }
      if (
        this.consumedAt &&
        this.revokeEffectiveAt &&
        this.consumedAt >= this.revokeEffectiveAt
      ) {
        this.invalidate(
          'consumedAt',
          'Admin interview cannot be consumed after revocation',
        )
      }
      return
    }

    if (
      this.endsAt.getTime() - this.startsAt.getTime() >
      ADMIN_ENTITLEMENT_COMP_MAX_VALIDITY_DAYS * DAY_MS
    ) {
      this.invalidate(
        'endsAt',
        'Admin comp authority cannot exceed 90 days',
      )
    }
    if (
      !completeEvidence(compFields) ||
      !this.authorityEnvelope.interviewCounterEpoch ||
      !this.authorityEnvelope.premiumResumeCounterEpoch
    ) {
      this.invalidate(
        'authorityEnvelope',
        'Admin comp authority requires complete catalog, counters, and epochs',
      )
    }
    if (
      !absentEvidence(interviewFields) ||
      !absentEvidence(consumptionFields) ||
      !absentEvidence(restorationFields)
    ) {
      this.invalidate(
        'kind',
        'Admin comp authority cannot carry one-interview operational state',
      )
    }
    if (this.periodKey !== `admin-comp:${this.grantId}`) {
      this.invalidate(
        'periodKey',
        'Admin comp period must derive exactly from its grant lineage',
      )
    }
    if (
      this.interviewsUsed !== undefined &&
      this.interviewLimitSnapshot !== undefined &&
      this.interviewsUsed > this.interviewLimitSnapshot
    ) {
      this.invalidate(
        'interviewsUsed',
        'Admin comp interview usage cannot exceed its snapshot limit',
      )
    }
    if (
      this.premiumResumesUsed !== undefined &&
      this.premiumResumeLimitSnapshot !== undefined &&
      this.premiumResumesUsed > this.premiumResumeLimitSnapshot
    ) {
      this.invalidate(
        'premiumResumesUsed',
        'Admin comp resume usage cannot exceed its snapshot limit',
      )
    }
    const displaced = this.displacedBasicProjection
    if (
      displaced &&
      (
        displaced.interviewsUsed > displaced.interviewLimit ||
        displaced.premiumResumesUsed >
          displaced.premiumResumeLimit
      )
    ) {
      this.invalidate(
        'displacedBasicProjection',
        'Displaced Basic counters cannot exceed their limits',
      )
    }
  },
)

AdminEntitlementProjectionSchema.index(
  { grantId: 1 },
  { unique: true },
)
AdminEntitlementProjectionSchema.index({
  userId: 1,
  kind: 1,
  lifecycleState: 1,
  startsAt: 1,
  endsAt: 1,
})
AdminEntitlementProjectionSchema.index({
  lifecycleState: 1,
  startsAt: 1,
  endsAt: 1,
  _id: 1,
})
AdminEntitlementProjectionSchema.index(
  { periodKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kind: 'comp_period',
      periodKey: { $type: 'string' },
    },
  },
)
AdminEntitlementProjectionSchema.index(
  { consumedSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      consumedSessionId: { $type: 'objectId' },
    },
  },
)
AdminEntitlementProjectionSchema.index(
  { consumedUsageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      consumedUsageId: { $type: 'objectId' },
    },
  },
)
AdminEntitlementProjectionSchema.index(
  { restorationId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      restorationId: { $type: 'objectId' },
    },
  },
)

export const AdminEntitlementProjection:
Model<IAdminEntitlementProjection> =
  mongoose.models.AdminEntitlementProjection ||
  mongoose.model<IAdminEntitlementProjection>(
    'AdminEntitlementProjection',
    AdminEntitlementProjectionSchema,
  )
