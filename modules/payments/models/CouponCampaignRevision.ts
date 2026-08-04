import mongoose, {
  Document,
  Model,
  Query,
  Schema,
} from 'mongoose'
import {
  COUPON_LIFECYCLE_HISTORY_MAX_ENTRIES,
  COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION,
  validateCouponLifecycleHistory,
  type CouponLifecycleTransition,
} from '../lib/couponLifecycleHistory'
import {
  COUPON_REVISION_STATUSES,
  type CatalogApprovalSnapshot,
  type CouponPolicyApprovalKind,
  type CouponPolicyApprovalSnapshot,
  type CouponRevisionStatus,
  type CouponRevisionTerms,
  type CouponValidationSnapshot,
  type ProviderMode,
  type ProviderVerificationSnapshot,
} from '../types/catalog'

export interface ICouponCampaignRevision extends Document {
  campaignId: mongoose.Types.ObjectId
  revision: number
  status: CouponRevisionStatus
  editRevision: number
  terms: CouponRevisionTerms
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: CatalogApprovalSnapshot
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  lifecycleClaim?: 'live'
  lifecycleHistory?: CouponLifecycleTransition[]
  createdBy: mongoose.Types.ObjectId
  changeReason: string
  createdAt: Date
  updatedAt: Date
}

const CouponLifecycleTransitionSchema =
  new Schema<CouponLifecycleTransition>(
    {
      schemaVersion: {
        type: String,
        enum: [COUPON_LIFECYCLE_TRANSITION_SCHEMA_VERSION],
        required: true,
        immutable: true,
      },
      version: {
        type: Number,
        required: true,
        min: 1,
        immutable: true,
        validate: Number.isSafeInteger,
      },
      fromStatus: {
        type: String,
        enum: COUPON_REVISION_STATUSES,
        required: true,
        immutable: true,
      },
      toStatus: {
        type: String,
        enum: COUPON_REVISION_STATUSES,
        required: true,
        immutable: true,
      },
      effectiveAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      recordedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      scheduledStartAt: {
        type: Date,
        default: null,
        immutable: true,
      },
      scheduledEndAt: {
        type: Date,
        default: null,
        immutable: true,
      },
      actorDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      mutationIdDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      correlationIdDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      reasonDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      auditLinkDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      previousTransitionDigest: {
        type: String,
        default: null,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      transitionDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
    },
    { _id: false, strict: 'throw' },
  )

const CouponCampaignRevisionSchema = new Schema<ICouponCampaignRevision>(
  {
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: 'CouponCampaign',
      required: true,
    },
    revision: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: COUPON_REVISION_STATUSES,
      default: 'draft',
      required: true,
    },
    editRevision: { type: Number, required: true, min: 0, default: 0 },
    terms: { type: Schema.Types.Mixed, required: true },
    contentHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    validation: { type: Schema.Types.Mixed },
    approval: { type: Schema.Types.Mixed },
    policyApprovals: { type: Schema.Types.Mixed },
    providerVerification: { type: Schema.Types.Mixed },
    lifecycleClaim: { type: String, enum: ['live'] },
    lifecycleHistory: {
      type: [CouponLifecycleTransitionSchema],
      default: [],
      validate: {
        validator: (value: unknown[]) =>
          value.length <= COUPON_LIFECYCLE_HISTORY_MAX_ENTRIES,
        message: 'Coupon lifecycle history exceeds its safe bound',
      },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    changeReason: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
  },
  { timestamps: true },
)

CouponCampaignRevisionSchema.index(
  { campaignId: 1, revision: 1 },
  { unique: true },
)
CouponCampaignRevisionSchema.index(
  { campaignId: 1, lifecycleClaim: 1 },
  { unique: true, sparse: true },
)
CouponCampaignRevisionSchema.index({
  status: 1,
  'terms.startsAt': 1,
  'terms.endsAt': 1,
  'terms.priority': -1,
})

function updateOnlyChangesLifecycle(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const record = update as Record<string, unknown>
  const operators = Object.keys(record).filter((key) => key.startsWith('$'))
  if (
    operators.some(
      (operator) =>
        operator !== '$set' &&
        operator !== '$unset' &&
        operator !== '$push' &&
        operator !== '$setOnInsert',
    )
  ) {
    return false
  }
  const set = (
    record.$set && typeof record.$set === 'object'
      ? record.$set
      : record
  ) as Record<string, unknown>
  const unset = (
    record.$unset && typeof record.$unset === 'object'
      ? record.$unset
      : {}
  ) as Record<string, unknown>
  const push = (
    record.$push && typeof record.$push === 'object'
      ? record.$push
      : {}
  ) as Record<string, unknown>
  const setOnInsert = (
    record.$setOnInsert && typeof record.$setOnInsert === 'object'
      ? record.$setOnInsert
      : {}
  ) as Record<string, unknown>
  const allowed = new Set(['status', 'lifecycleClaim', 'updatedAt'])
  return (
    typeof set.status === 'string' &&
    Object.keys(set).every((key) => allowed.has(key)) &&
    Object.keys(unset).every((key) => key === 'lifecycleClaim') &&
    Object.keys(setOnInsert).every((key) => key === 'createdAt') &&
    Object.keys(push).length === 1 &&
    Object.hasOwn(push, 'lifecycleHistory') &&
    Boolean(
      push.lifecycleHistory &&
      typeof push.lifecycleHistory === 'object' &&
      !Array.isArray(push.lifecycleHistory),
    )
  )
}

function updateTouchesLifecycle(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const lifecyclePaths = [
    'status',
    'lifecycleClaim',
    'lifecycleHistory',
  ] as const
  return Object.entries(update as Record<string, unknown>).some(
    ([operatorOrPath, value]) => {
      if (!operatorOrPath.startsWith('$')) {
        return lifecyclePaths.some(
          (path) => path === operatorOrPath,
        )
      }
      return Boolean(
        value &&
        typeof value === 'object' &&
        Object.keys(value).some((path) =>
          lifecyclePaths.some(
            (lifecyclePath) =>
              path === lifecyclePath ||
              path.startsWith(`${lifecyclePath}.`),
          )),
      )
    },
  )
}

function emptyHistoryCas(filter: Record<string, unknown>): boolean {
  if (!Array.isArray(filter.$or)) return false
  const conditions = filter.$or.filter(
    (value): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  )
  return (
    conditions.some((condition) => {
      const value = condition.lifecycleHistory
      return Boolean(
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).$exists === false,
      )
    }) &&
    conditions.some((condition) => {
      const value = condition.lifecycleHistory
      return Boolean(
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).$size === 0,
      )
    })
  )
}

CouponCampaignRevisionSchema.pre(
  'validate',
  function validateLifecycleHistory() {
    const lifecycleHistory = (this.lifecycleHistory ?? []).map(
      (transition) => {
        const candidate = transition as CouponLifecycleTransition & {
          toObject?: () => unknown
        }
        return typeof candidate.toObject === 'function'
          ? candidate.toObject()
          : candidate
      },
    )
    if (
      !validateCouponLifecycleHistory({
        campaignId: this.campaignId.toString(),
        revision: this.revision,
        value: lifecycleHistory,
        terms: this.terms,
        currentStatus: this.status,
        allowEmpty: true,
      })
    ) {
      this.invalidate(
        'lifecycleHistory',
        'Coupon lifecycle history is malformed or retroactive',
      )
    }
  },
)

async function rejectImmutableCouponUpdate(
  this: Query<unknown, ICouponCampaignRevision>,
): Promise<void> {
  const current = await this.model
    .findOne(this.getFilter())
    .select(
      'campaignId revision status editRevision terms contentHash ' +
      'lifecycleHistory',
    )
    .lean<Pick<
      ICouponCampaignRevision,
      | 'campaignId'
      | 'revision'
      | 'status'
      | 'editRevision'
      | 'terms'
      | 'contentHash'
      | 'lifecycleHistory'
    >>()
  const update = this.getUpdate()
  if (!current) return
  if (
    current.status === 'draft' &&
    !updateTouchesLifecycle(update)
  ) {
    return
  }
  if (
    this.getOptions().upsert ||
    !updateOnlyChangesLifecycle(update)
  ) {
    throw new Error('Non-draft coupon revisions are immutable')
  }
  const record = update as Record<string, unknown>
  const set = record.$set as Record<string, unknown>
  const unset = (
    record.$unset && typeof record.$unset === 'object'
      ? record.$unset
      : {}
  ) as Record<string, unknown>
  const push = record.$push as Record<string, unknown>
  const transition = push.lifecycleHistory as
    CouponLifecycleTransition
  const history = current.lifecycleHistory ?? []
  const filter = this.getFilter() as Record<string, unknown>
  const tail = history.at(-1)
  const historyCas = tail
    ? (
        (filter.lifecycleHistory as Record<string, unknown> | undefined)
          ?.$size === history.length &&
        filter[
          `lifecycleHistory.${history.length - 1}.transitionDigest`
        ] === tail.transitionDigest
      )
    : emptyHistoryCas(filter)
  const targetHasClaim =
    set.status === 'active' || set.status === 'scheduled'
  const lifecycleClaimValid = targetHasClaim
    ? (
        set.lifecycleClaim === 'live' &&
        !Object.hasOwn(unset, 'lifecycleClaim')
      )
    : (
        unset.lifecycleClaim === 1 &&
        !Object.hasOwn(set, 'lifecycleClaim')
      )
  if (
    filter.status !== current.status ||
    filter.editRevision !== current.editRevision ||
    (
      current.status === 'draft' &&
      filter.contentHash !== current.contentHash
    ) ||
    !historyCas ||
    !lifecycleClaimValid ||
    transition.fromStatus !== current.status ||
    transition.toStatus !== set.status ||
    !COUPON_REVISION_STATUSES.includes(
      set.status as CouponRevisionStatus,
    ) ||
    !validateCouponLifecycleHistory({
      campaignId: current.campaignId.toString(),
      revision: current.revision,
      value: [...history, transition],
      terms: current.terms,
      currentStatus: set.status as CouponRevisionStatus,
    })
  ) {
    throw new Error(
      'Coupon lifecycle transition must be append-only and CAS-bound',
    )
  }
}

async function rejectImmutableCouponDelete(
  this: Query<unknown, ICouponCampaignRevision>,
): Promise<void> {
  const current = await this.model
    .findOne(this.getFilter())
    .select('status')
    .lean<{ status: CouponRevisionStatus }>()
  if (current && current.status !== 'draft') {
    throw new Error('Only draft coupon revisions can be deleted')
  }
}

CouponCampaignRevisionSchema.pre('updateOne', rejectImmutableCouponUpdate)
CouponCampaignRevisionSchema.pre('findOneAndUpdate', rejectImmutableCouponUpdate)
CouponCampaignRevisionSchema.pre('replaceOne', rejectImmutableCouponUpdate)
CouponCampaignRevisionSchema.pre('updateMany', function rejectCouponBulkUpdate() {
  throw new Error('Coupon revision bulk updates are not allowed')
})
CouponCampaignRevisionSchema.pre('deleteOne', rejectImmutableCouponDelete)
CouponCampaignRevisionSchema.pre('findOneAndDelete', rejectImmutableCouponDelete)
CouponCampaignRevisionSchema.pre('deleteMany', function rejectCouponBulkDelete() {
  throw new Error('Coupon revision bulk deletes are not allowed')
})

export const CouponCampaignRevision: Model<ICouponCampaignRevision> =
  mongoose.models.CouponCampaignRevision ||
  mongoose.model<ICouponCampaignRevision>(
    'CouponCampaignRevision',
    CouponCampaignRevisionSchema,
  )
