import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const RESUME_ENTITLEMENT_SOURCES = [
  'free_basic',
  'plus_cycle',
  'pro_cycle',
  'premium_resume',
  'admin',
  'admin_comp',
] as const
export type ResumeEntitlementSource =
  (typeof RESUME_ENTITLEMENT_SOURCES)[number]

export const RESUME_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION = 1 as const

export interface IResumeEntitlementCounterEpochV1 {
  epochId: string
  epochNumber: number
}

export interface IResumeEntitlementAuthorityEnvelopeV1 {
  version: typeof RESUME_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION
  adminGrantId?: string
  adminCompPeriodId?: mongoose.Types.ObjectId
  counterEpoch?: IResumeEntitlementCounterEpochV1
}

export const RESUME_ENTITLEMENT_STATUSES = [
  'active',
  'expired',
  'revoked',
  'review',
] as const
export type ResumeEntitlementStatus =
  (typeof RESUME_ENTITLEMENT_STATUSES)[number]

export const PREMIUM_RESUME_REVISION_WINDOW_DAYS = 7 as const
export const ADMIN_RESUME_REDEMPTION_WINDOW_DAYS = 30 as const
const PREMIUM_RESUME_REVISION_WINDOW_MS =
  PREMIUM_RESUME_REVISION_WINDOW_DAYS * 24 * 60 * 60 * 1000
const ADMIN_RESUME_REDEMPTION_WINDOW_MS =
  ADMIN_RESUME_REDEMPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000

export interface IResumeEntitlement extends Document {
  userId: mongoose.Types.ObjectId
  resumeId: string
  source: ResumeEntitlementSource
  providerMode?: ProviderMode
  periodKey?: string
  subscriptionCycleId?: mongoose.Types.ObjectId
  checkoutIntentId?: mongoose.Types.ObjectId
  razorpayPaymentId?: string
  status: ResumeEntitlementStatus
  revisionWindowStartsAt?: Date
  revisionWindowEndsAt?: Date
  firstSuccessfulRenderAt?: Date
  redemptionStartsAt?: Date
  redemptionEndsAt?: Date
  revokeEffectiveAt?: Date
  authorityEnvelope?: IResumeEntitlementAuthorityEnvelopeV1
  createdAt: Date
  updatedAt: Date
}

const AUTHORITY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

const ResumeEntitlementCounterEpochV1Schema =
  new Schema<IResumeEntitlementCounterEpochV1>(
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

const ResumeEntitlementAuthorityEnvelopeV1Schema =
  new Schema<IResumeEntitlementAuthorityEnvelopeV1>(
    {
      version: {
        type: Number,
        enum: [RESUME_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION],
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
      adminCompPeriodId: {
        type: Schema.Types.ObjectId,
        ref: 'AdminEntitlementProjection',
      },
      counterEpoch: {
        type: ResumeEntitlementCounterEpochV1Schema,
      },
    },
    { _id: false },
  )

const ResumeEntitlementSchema = new Schema<IResumeEntitlement>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    resumeId: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    source: {
      type: String,
      enum: RESUME_ENTITLEMENT_SOURCES,
      required: true,
      immutable: true,
    },
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      immutable: true,
    },
    periodKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 255,
      immutable: true,
    },
    subscriptionCycleId: {
      type: Schema.Types.ObjectId,
      ref: 'SubscriptionCycle',
      immutable: true,
    },
    checkoutIntentId: {
      type: Schema.Types.ObjectId,
      ref: 'CheckoutIntent',
      immutable: true,
    },
    razorpayPaymentId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    status: {
      type: String,
      enum: RESUME_ENTITLEMENT_STATUSES,
      required: true,
      default: 'active',
    },
    revisionWindowStartsAt: { type: Date },
    revisionWindowEndsAt: { type: Date },
    firstSuccessfulRenderAt: { type: Date },
    redemptionStartsAt: {
      type: Date,
      immutable: true,
    },
    redemptionEndsAt: {
      type: Date,
      immutable: true,
    },
    revokeEffectiveAt: {
      type: Date,
    },
    authorityEnvelope: {
      type: ResumeEntitlementAuthorityEnvelopeV1Schema,
      default: undefined,
      immutable: true,
    },
  },
  { timestamps: true },
)

ResumeEntitlementSchema.pre(
  'validate',
  function validateResumeEntitlement() {
    const isCycle =
      this.source === 'plus_cycle' ||
      this.source === 'pro_cycle'
    const isPremiumPurchase = this.source === 'premium_resume'
    const isAdminGrant = this.source === 'admin'
    const isAdminComp = this.source === 'admin_comp'
    const authority = this.authorityEnvelope
    const isVersionedAdminGrant = isAdminGrant && authority !== undefined
    const hasPaymentLink =
      this.checkoutIntentId !== undefined ||
      this.razorpayPaymentId !== undefined
    const hasRevisionWindow =
      this.revisionWindowStartsAt !== undefined ||
      this.revisionWindowEndsAt !== undefined ||
      this.firstSuccessfulRenderAt !== undefined
    const hasRedemptionWindow =
      this.redemptionStartsAt !== undefined ||
      this.redemptionEndsAt !== undefined
    const usesRevisionWindow =
      isPremiumPurchase || isVersionedAdminGrant

    if (isCycle) {
      if (!this.providerMode || !this.periodKey || !this.subscriptionCycleId) {
        this.invalidate(
          'subscriptionCycleId',
          'Cycle resume entitlement requires provider mode, period, and cycle',
        )
      }
      if (hasPaymentLink) {
        this.invalidate(
          'checkoutIntentId',
          'Cycle resume entitlement cannot carry one-time payment linkage',
        )
      }
    }

    if (isPremiumPurchase) {
      if (
        !this.providerMode ||
        !this.checkoutIntentId ||
        !this.razorpayPaymentId
      ) {
        this.invalidate(
          'checkoutIntentId',
          'Premium resume purchase requires provider-scoped payment linkage',
        )
      }
      if (this.periodKey || this.subscriptionCycleId) {
        this.invalidate(
          'periodKey',
          'Premium resume purchase is not a subscription-cycle entitlement',
        )
      }
    }

    if (
      (
        this.source === 'free_basic' ||
        isAdminGrant ||
        isAdminComp
      ) &&
      (hasPaymentLink || this.subscriptionCycleId)
    ) {
      this.invalidate(
        'source',
        'Non-payment resume entitlement cannot carry payment linkage',
      )
    }

    if (this.source === 'free_basic') {
      if (this.periodKey || this.providerMode || hasRevisionWindow) {
        this.invalidate(
          'source',
          'Free basic resume entitlement is non-expiring and period-free',
        )
      }
      if (this.status === 'expired') {
        this.invalidate(
          'status',
          'Free basic resume entitlement cannot expire',
        )
      }
    }

    if (hasRevisionWindow && !usesRevisionWindow) {
      this.invalidate(
        'firstSuccessfulRenderAt',
        'Only one-time premium resume authority uses a revision window',
      )
    }

    if (usesRevisionWindow) {
      const windowValues = [
        this.revisionWindowStartsAt,
        this.revisionWindowEndsAt,
        this.firstSuccessfulRenderAt,
      ]
      const presentCount = windowValues.filter(
        (value) => value !== undefined,
      ).length

      if (presentCount !== 0 && presentCount !== windowValues.length) {
        this.invalidate(
          'firstSuccessfulRenderAt',
          isPremiumPurchase
            ? 'Premium revision window starts only with first successful render'
            : 'Admin resume revision starts only with first successful render',
        )
      }

      if (
        this.firstSuccessfulRenderAt &&
        this.revisionWindowStartsAt &&
        this.revisionWindowEndsAt
      ) {
        if (
          this.firstSuccessfulRenderAt.getTime() !==
          this.revisionWindowStartsAt.getTime()
        ) {
          this.invalidate(
            'revisionWindowStartsAt',
            'Revision window must start at first successful render',
          )
        }
        if (
          this.revisionWindowEndsAt.getTime() !==
          this.revisionWindowStartsAt.getTime() +
            PREMIUM_RESUME_REVISION_WINDOW_MS
        ) {
          this.invalidate(
            'revisionWindowEndsAt',
            isPremiumPurchase
              ? 'Premium resume revision window must be exactly seven days'
              : 'Admin resume revision window must be exactly seven days',
          )
        }
      }

      if (
        isPremiumPurchase &&
        this.status === 'expired' &&
        presentCount !== windowValues.length
      ) {
        this.invalidate(
          'status',
          'Premium resume cannot expire before its render window starts',
        )
      }
    }

    if (!authority) {
      if (hasRedemptionWindow || this.revokeEffectiveAt !== undefined) {
        this.invalidate(
          'authorityEnvelope',
          'Authority timing fields require a versioned authority envelope',
        )
      }
      return
    }

    const hasAdminGrantId = authority.adminGrantId !== undefined
    const hasAdminCompPeriodId =
      authority.adminCompPeriodId !== undefined
    const hasCounterEpoch = authority.counterEpoch !== undefined

    if (isAdminGrant) {
      if (
        !hasAdminGrantId ||
        hasAdminCompPeriodId ||
        hasCounterEpoch ||
        this.providerMode !== undefined ||
        this.periodKey !== undefined
      ) {
        this.invalidate(
          'authorityEnvelope',
          'Versioned admin resume grant requires exact one-time grant lineage',
        )
      }
      if (!this.redemptionStartsAt || !this.redemptionEndsAt) {
        this.invalidate(
          'redemptionEndsAt',
          'Versioned admin resume grant requires a redemption interval',
        )
      }
    } else if (isAdminComp) {
      if (
        !hasAdminGrantId ||
        !hasAdminCompPeriodId ||
        !hasCounterEpoch ||
        !this.periodKey ||
        this.periodKey !== `admin-comp:${authority.adminGrantId}` ||
        this.providerMode !== undefined ||
        hasRedemptionWindow ||
        hasRevisionWindow
      ) {
        this.invalidate(
          'authorityEnvelope',
          'Versioned admin comp resume requires exact period and counter lineage',
        )
      }
    } else if (isCycle) {
      if (
        hasAdminGrantId ||
        hasAdminCompPeriodId ||
        !hasCounterEpoch ||
        hasRedemptionWindow ||
        this.revokeEffectiveAt !== undefined
      ) {
        this.invalidate(
          'authorityEnvelope',
          'Versioned subscription resume requires only counter-epoch lineage',
        )
      }
    } else {
      this.invalidate(
        'authorityEnvelope',
        'This resume source cannot carry a versioned authority envelope',
      )
    }

    if (
      this.redemptionStartsAt &&
      this.redemptionEndsAt &&
      this.redemptionEndsAt <= this.redemptionStartsAt
    ) {
      this.invalidate(
        'redemptionEndsAt',
        'Admin resume redemption must end after it starts',
      )
    }
    if (
      isAdminGrant &&
      this.redemptionStartsAt &&
      this.redemptionEndsAt &&
      this.redemptionEndsAt.getTime() -
        this.redemptionStartsAt.getTime() >
        ADMIN_RESUME_REDEMPTION_WINDOW_MS
    ) {
      this.invalidate(
        'redemptionEndsAt',
        'Admin resume redemption cannot exceed 30 days',
      )
    }
    if (
      this.revokeEffectiveAt &&
      this.redemptionStartsAt &&
      this.revokeEffectiveAt < this.redemptionStartsAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Admin resume revocation cannot precede redemption availability',
      )
    }
    const adminAccessEndsAt =
      isAdminGrant &&
      this.firstSuccessfulRenderAt &&
      this.revisionWindowStartsAt &&
      this.revisionWindowEndsAt
        ? this.revisionWindowEndsAt
        : this.redemptionEndsAt
    if (
      this.revokeEffectiveAt &&
      adminAccessEndsAt &&
      this.revokeEffectiveAt > adminAccessEndsAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Admin resume revocation cannot follow effective access expiry',
      )
    }
    if (
      (isAdminGrant || isAdminComp) &&
      this.status === 'revoked' &&
      !this.revokeEffectiveAt
    ) {
      this.invalidate(
        'revokeEffectiveAt',
        'Revoked admin resume authority requires revocation evidence',
      )
    }
    if (
      isAdminGrant &&
      this.firstSuccessfulRenderAt &&
      this.redemptionStartsAt &&
      this.redemptionEndsAt &&
      (
        this.firstSuccessfulRenderAt < this.redemptionStartsAt ||
        this.firstSuccessfulRenderAt >= this.redemptionEndsAt
      )
    ) {
      this.invalidate(
        'firstSuccessfulRenderAt',
        'Admin resume first render must occur inside its redemption interval',
      )
    }
    if (
      isAdminGrant &&
      this.firstSuccessfulRenderAt &&
      this.revokeEffectiveAt &&
      this.firstSuccessfulRenderAt >= this.revokeEffectiveAt
    ) {
      this.invalidate(
        'firstSuccessfulRenderAt',
        'Admin resume cannot first render after revocation',
      )
    }
  },
)

ResumeEntitlementSchema.index(
  { userId: 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: 'free_basic',
    },
  },
)
ResumeEntitlementSchema.index(
  { userId: 1, resumeId: 1, source: 1, periodKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      periodKey: { $type: 'string' },
    },
  },
)
ResumeEntitlementSchema.index(
  { providerMode: 1, razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayPaymentId: { $type: 'string' },
    },
  },
)
ResumeEntitlementSchema.index(
  { providerMode: 1, checkoutIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutIntentId: { $type: 'objectId' },
    },
  },
)
ResumeEntitlementSchema.index({
  userId: 1,
  resumeId: 1,
  status: 1,
})
ResumeEntitlementSchema.index({
  providerMode: 1,
  subscriptionCycleId: 1,
})
ResumeEntitlementSchema.index(
  { 'authorityEnvelope.adminGrantId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: 'admin',
      'authorityEnvelope.version':
        RESUME_ENTITLEMENT_AUTHORITY_ENVELOPE_VERSION,
      'authorityEnvelope.adminGrantId': { $type: 'string' },
    },
  },
)
ResumeEntitlementSchema.index({
  userId: 1,
  source: 1,
  periodKey: 1,
  'authorityEnvelope.counterEpoch.epochId': 1,
})

export const ResumeEntitlement: Model<IResumeEntitlement> =
  mongoose.models.ResumeEntitlement ||
  mongoose.model<IResumeEntitlement>(
    'ResumeEntitlement',
    ResumeEntitlementSchema,
  )
