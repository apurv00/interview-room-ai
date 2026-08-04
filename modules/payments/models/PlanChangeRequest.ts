import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

export const PLAN_CHANGE_REQUEST_SOURCES = [
  'customer',
  'admin',
] as const
export type PlanChangeRequestSource =
  (typeof PLAN_CHANGE_REQUEST_SOURCES)[number]

export const PLAN_CHANGE_ADMIN_CONTROL_VERSION = 1 as const

export interface PlanChangeAdminControlV1 {
  version: typeof PLAN_CHANGE_ADMIN_CONTROL_VERSION
  requestHash: string
  confirmationHash: string
  correlationId: string
  ticketId: string
  reason: string
}

export type PlanChangeControlLineage =
  | 'customer'
  | 'admin_v1'
  | 'admin_legacy_unactionable'

interface PlanChangeControlEvidence {
  userId: unknown
  actorUserId: unknown
  source: unknown
  adminControl?: unknown
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const ADMIN_CONTROL_KEYS = [
  'confirmationHash',
  'correlationId',
  'reason',
  'requestHash',
  'ticketId',
  'version',
] as const

function exactObjectId(value: unknown): string | undefined {
  if (
    value instanceof mongoose.Types.ObjectId ||
    typeof value === 'string'
  ) {
    const serialized = String(value)
    return /^[a-fA-F0-9]{24}$/.test(serialized)
      ? serialized.toLowerCase()
      : undefined
  }
  return undefined
}

function exactBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
): string | undefined {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  )
    ? value
    : undefined
}

export function parsePlanChangeAdminControlV1(
  value: unknown,
): PlanChangeAdminControlV1 | undefined {
  if (!value || typeof value !== 'object') return undefined
  const maybeDocument = value as {
    toObject?: (options?: Readonly<Record<string, unknown>>) => unknown
  }
  const normalized = typeof maybeDocument.toObject === 'function'
    ? maybeDocument.toObject({
        depopulate: true,
        getters: false,
        virtuals: false,
      })
    : value
  if (!normalized || typeof normalized !== 'object') return undefined
  const row = normalized as Partial<Record<
    keyof PlanChangeAdminControlV1,
    unknown
  >>
  const keys = Object.keys(row).sort()
  if (
    keys.length !== ADMIN_CONTROL_KEYS.length ||
    keys.some((key, index) => key !== ADMIN_CONTROL_KEYS[index])
  ) {
    return undefined
  }
  const requestHash = exactBoundedString(row.requestHash, 64, 64)
  const confirmationHash = exactBoundedString(
    row.confirmationHash,
    64,
    64,
  )
  const correlationId = exactBoundedString(row.correlationId, 1, 200)
  const ticketId = exactBoundedString(row.ticketId, 1, 120)
  const reason = exactBoundedString(row.reason, 10, 2000)
  if (
    row.version !== PLAN_CHANGE_ADMIN_CONTROL_VERSION ||
    !requestHash ||
    !SHA256_PATTERN.test(requestHash) ||
    !confirmationHash ||
    !SHA256_PATTERN.test(confirmationHash) ||
    !correlationId ||
    !ticketId ||
    !reason
  ) {
    return undefined
  }
  return {
    version: PLAN_CHANGE_ADMIN_CONTROL_VERSION,
    requestHash,
    confirmationHash,
    correlationId,
    ticketId,
    reason,
  }
}

export function classifyPlanChangeControlLineage(
  evidence: PlanChangeControlEvidence,
): PlanChangeControlLineage | undefined {
  const userId = exactObjectId(evidence.userId)
  const actorUserId = exactObjectId(evidence.actorUserId)
  if (!userId || !actorUserId) return undefined
  if (evidence.source === 'customer') {
    return (
      actorUserId === userId &&
      evidence.adminControl === undefined
    )
      ? 'customer'
      : undefined
  }
  if (evidence.source !== 'admin') return undefined
  return parsePlanChangeAdminControlV1(evidence.adminControl)
    ? 'admin_v1'
    : 'admin_legacy_unactionable'
}

export function exactPlanChangeControlFilter(
  evidence: PlanChangeControlEvidence,
): Readonly<Record<string, unknown>> | undefined {
  const lineage = classifyPlanChangeControlLineage(evidence)
  if (!lineage || lineage === 'admin_legacy_unactionable') {
    return undefined
  }
  const actorUserId = exactObjectId(evidence.actorUserId)
  if (!actorUserId) return undefined
  if (lineage === 'customer') {
    return {
      actorUserId: new mongoose.Types.ObjectId(actorUserId),
      source: 'customer',
      adminControl: { $exists: false },
    }
  }
  const adminControl =
    parsePlanChangeAdminControlV1(evidence.adminControl)
  if (!adminControl) return undefined
  return {
    actorUserId: new mongoose.Types.ObjectId(actorUserId),
    source: 'admin',
    'adminControl.version': adminControl.version,
    'adminControl.requestHash': adminControl.requestHash,
    'adminControl.confirmationHash': adminControl.confirmationHash,
    'adminControl.correlationId': adminControl.correlationId,
    'adminControl.ticketId': adminControl.ticketId,
    'adminControl.reason': adminControl.reason,
  }
}

export const PLAN_CHANGE_REQUEST_OPERATIONS = [
  'tier_change',
  'period_end_cancel',
  'resubscribe',
] as const
export type PlanChangeRequestOperation =
  (typeof PLAN_CHANGE_REQUEST_OPERATIONS)[number]

export const PLAN_CHANGE_REQUEST_STATUSES = [
  'requested',
  'authorization_pending',
  'old_cancellation_pending',
  'reconciling',
  'scheduled',
  'applying',
  'compensating',
  'applied',
  'cancelled',
  'failed',
  'review',
] as const
export type PlanChangeRequestStatus =
  (typeof PLAN_CHANGE_REQUEST_STATUSES)[number]

export const PLAN_CHANGE_REQUEST_OUTCOMES = [
  'applied',
  'cancelled',
  'failed',
  'superseded',
] as const
export type PlanChangeRequestOutcome =
  (typeof PLAN_CHANGE_REQUEST_OUTCOMES)[number]

export type ConsumerPlanKey = 'free' | 'plus' | 'pro'

export interface IPlanChangeRequest extends Document {
  userId: mongoose.Types.ObjectId
  actorUserId: mongoose.Types.ObjectId
  source: PlanChangeRequestSource
  adminControl?: PlanChangeAdminControlV1
  operation: PlanChangeRequestOperation
  fromPlanKey: ConsumerPlanKey
  toPlanKey: ConsumerPlanKey
  targetCatalogVersion: string
  idempotencyKey: string
  checkoutSelectionHash?: string
  requestedAt: Date
  requestedEffectiveAt: Date
  providerMode?: ProviderMode
  checkoutIntentId?: mongoose.Types.ObjectId
  fromSubscriptionId?: mongoose.Types.ObjectId
  fromLeaseLane?: 'a' | 'b'
  toSubscriptionId?: mongoose.Types.ObjectId
  fromRazorpaySubscriptionId?: string
  toRazorpaySubscriptionId?: string
  targetRazorpayPlanId?: string
  activeFenceKey?: string
  status: PlanChangeRequestStatus
  authorizationExpiresAt?: Date
  replacementAuthorizationPaymentId?: string
  replacementAuthorizedAt?: Date
  oldCancellationAcceptedAt?: Date
  oldCancellationEffectiveAt?: Date
  replacementCancellationAcceptedAt?: Date
  replacementTerminalVerifiedAt?: Date
  lastProviderObservedAt?: Date
  nextRecoveryAt?: Date
  outcome?: PlanChangeRequestOutcome
  outcomeAt?: Date
  effectiveAt?: Date
  outcomeReason?: string
  providerSnapshot?: unknown
  attempts: number
  lastError?: string
  createdAt: Date
  updatedAt: Date
}

const PlanChangeAdminControlSchema =
  new Schema<PlanChangeAdminControlV1>(
    {
      version: {
        type: Number,
        required: true,
        enum: [PLAN_CHANGE_ADMIN_CONTROL_VERSION],
        immutable: true,
      },
      requestHash: {
        type: String,
        required: true,
        match: SHA256_PATTERN,
        immutable: true,
      },
      confirmationHash: {
        type: String,
        required: true,
        match: SHA256_PATTERN,
        immutable: true,
      },
      correlationId: {
        type: String,
        required: true,
        minlength: 1,
        maxlength: 200,
        immutable: true,
      },
      ticketId: {
        type: String,
        required: true,
        minlength: 1,
        maxlength: 120,
        immutable: true,
      },
      reason: {
        type: String,
        required: true,
        minlength: 10,
        maxlength: 2000,
        immutable: true,
      },
    },
    {
      _id: false,
      id: false,
      strict: 'throw',
    },
  )

const PlanChangeRequestSchema = new Schema<IPlanChangeRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: PLAN_CHANGE_REQUEST_SOURCES,
      required: true,
      immutable: true,
    },
    adminControl: {
      type: PlanChangeAdminControlSchema,
      default: undefined,
      immutable: true,
    },
    operation: {
      type: String,
      enum: PLAN_CHANGE_REQUEST_OPERATIONS,
      required: true,
      default: 'tier_change',
      immutable: true,
    },
    fromPlanKey: {
      type: String,
      enum: ['free', 'plus', 'pro'],
      required: true,
      immutable: true,
    },
    toPlanKey: {
      type: String,
      enum: ['free', 'plus', 'pro'],
      required: true,
      immutable: true,
    },
    targetCatalogVersion: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
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
    checkoutSelectionHash: {
      type: String,
      trim: true,
      lowercase: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    requestedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    requestedEffectiveAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    providerMode: {
      type: String,
      enum: PROVIDER_MODES,
      immutable: true,
    },
    checkoutIntentId: {
      type: Schema.Types.ObjectId,
      ref: 'CheckoutIntent',
      immutable: true,
    },
    fromSubscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentSubscription',
      immutable: true,
    },
    fromLeaseLane: {
      type: String,
      enum: ['a', 'b'],
      immutable: true,
    },
    toSubscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentSubscription',
    },
    fromRazorpaySubscriptionId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    toRazorpaySubscriptionId: {
      type: String,
      trim: true,
      maxlength: 255,
    },
    targetRazorpayPlanId: {
      type: String,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    activeFenceKey: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 64,
    },
    status: {
      type: String,
      enum: PLAN_CHANGE_REQUEST_STATUSES,
      required: true,
      default: 'requested',
    },
    authorizationExpiresAt: {
      type: Date,
      immutable: true,
    },
    replacementAuthorizationPaymentId: {
      type: String,
      trim: true,
      match: /^pay_[A-Za-z0-9]+$/,
      maxlength: 128,
    },
    replacementAuthorizedAt: { type: Date },
    oldCancellationAcceptedAt: { type: Date },
    oldCancellationEffectiveAt: { type: Date },
    replacementCancellationAcceptedAt: { type: Date },
    replacementTerminalVerifiedAt: { type: Date },
    lastProviderObservedAt: { type: Date },
    nextRecoveryAt: { type: Date },
    outcome: {
      type: String,
      enum: PLAN_CHANGE_REQUEST_OUTCOMES,
    },
    outcomeAt: { type: Date },
    effectiveAt: { type: Date },
    outcomeReason: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    providerSnapshot: {
      type: Schema.Types.Mixed,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (value: number) => (
          Number.isSafeInteger(value) && value >= 0
        ),
        message: 'attempts must be a non-negative safe integer',
      },
    },
    lastError: {
      type: String,
      maxlength: 2000,
    },
  },
  { timestamps: true },
)

PlanChangeRequestSchema.pre(
  'validate',
  function validatePlanChangeRequest() {
    if (
      this.operation === 'tier_change' &&
      this.fromPlanKey === this.toPlanKey
    ) {
      this.invalidate(
        'toPlanKey',
        'Plan change must move to a different tier',
      )
    }
    if (
      this.operation === 'tier_change' &&
      (
        this.fromPlanKey === 'free' ||
        this.toPlanKey === 'free'
      )
    ) {
      this.invalidate(
        'operation',
        'Tier change requires two different paid tiers',
      )
    }
    if (
      this.operation === 'resubscribe' &&
      (
        this.fromPlanKey !== this.toPlanKey ||
        this.toPlanKey === 'free'
      )
    ) {
      this.invalidate(
        'toPlanKey',
        'Resubscribe must replace the same paid tier',
      )
    }
    if (
      this.operation === 'period_end_cancel' &&
      (
        this.fromPlanKey === 'free' ||
        this.toPlanKey !== 'free'
      )
    ) {
      this.invalidate(
        'toPlanKey',
        'Period-end cancellation must move a paid tier to Basic',
      )
    }

    if (this.requestedEffectiveAt < this.requestedAt) {
      this.invalidate(
        'requestedEffectiveAt',
        'Requested effective time cannot precede the request',
      )
    }

    if (this.effectiveAt && this.effectiveAt < this.requestedAt) {
      this.invalidate(
        'effectiveAt',
        'Actual effective time cannot precede the request',
      )
    }

    if (
      this.source === 'customer' &&
      !this.actorUserId.equals(this.userId)
    ) {
      this.invalidate(
        'actorUserId',
        'Customer plan change actor must own the entitlement',
      )
    }

    const controlLineage = classifyPlanChangeControlLineage({
      userId: this.userId,
      actorUserId: this.actorUserId,
      source: this.source,
      adminControl: this.adminControl,
    })
    if (
      this.source === 'customer' &&
      controlLineage !== 'customer'
    ) {
      this.invalidate(
        'adminControl',
        'Customer plan changes cannot carry admin control metadata',
      )
    }
    if (
      this.source === 'admin' &&
      controlLineage !== 'admin_v1'
    ) {
      this.invalidate(
        'adminControl',
        'New admin plan changes require the complete v1 control envelope',
      )
    }

    const hasProviderReference = Boolean(
      this.checkoutIntentId ||
      this.fromSubscriptionId ||
      this.toSubscriptionId ||
      this.fromRazorpaySubscriptionId ||
      this.toRazorpaySubscriptionId ||
      this.targetRazorpayPlanId ||
      this.replacementAuthorizationPaymentId,
    )
    if (hasProviderReference && !this.providerMode) {
      this.invalidate(
        'providerMode',
        'Provider-linked plan change requires providerMode',
      )
    }

    if (
      this.source === 'customer' &&
      (this.fromPlanKey !== 'free' || this.toPlanKey !== 'free') &&
      !this.providerMode
    ) {
      this.invalidate(
        'providerMode',
        'Customer paid-plan changes require providerMode',
      )
    }

    if (
      this.source === 'customer' &&
      this.fromPlanKey !== 'free' &&
      (!this.fromSubscriptionId || !this.fromRazorpaySubscriptionId)
    ) {
      this.invalidate(
        'fromSubscriptionId',
        'Customer paid-plan change requires current subscription linkage',
      )
    }

    if (
      this.source === 'customer' &&
      this.toPlanKey !== 'free' &&
      !this.targetRazorpayPlanId
    ) {
      this.invalidate(
        'targetRazorpayPlanId',
        'Customer paid target requires the pinned Razorpay Plan',
      )
    }

    const isTerminalStatus = (
      this.status === 'applied' ||
      this.status === 'cancelled' ||
      this.status === 'failed'
    )
    if (this.providerMode && !isTerminalStatus) {
      const expectedFenceKey =
        `${this.providerMode}:${this.userId.toHexString()}`
      if (this.activeFenceKey !== expectedFenceKey) {
        this.invalidate(
          'activeFenceKey',
          'Active provider lifecycle requires the exact user-mode fence',
        )
      }
    } else if (isTerminalStatus && this.activeFenceKey) {
      this.invalidate(
        'activeFenceKey',
        'Terminal lifecycle requests must release the active fence',
      )
    }

    if (
      this.status === 'authorization_pending' &&
      this.toPlanKey !== 'free' &&
      (!this.checkoutIntentId || !this.authorizationExpiresAt)
    ) {
      this.invalidate(
        'checkoutIntentId',
        'Pending authorization requires checkout linkage and expiry',
      )
    }
    if (
      this.authorizationExpiresAt &&
      (
        this.authorizationExpiresAt <= this.requestedAt ||
        this.authorizationExpiresAt >= this.requestedEffectiveAt
      )
    ) {
      this.invalidate(
        'authorizationExpiresAt',
        'Authorization expiry must be after request and before activation',
      )
    }
    const hasAuthorizationId =
      this.replacementAuthorizationPaymentId !== undefined
    const hasAuthorizationTime =
      this.replacementAuthorizedAt !== undefined
    if (hasAuthorizationId !== hasAuthorizationTime) {
      this.invalidate(
        'replacementAuthorizedAt',
        'Replacement authorization id and time must be recorded together',
      )
    }
    if (
      this.replacementAuthorizedAt &&
      (
        this.replacementAuthorizedAt < this.requestedAt ||
        (
          this.authorizationExpiresAt &&
          this.replacementAuthorizedAt >= this.authorizationExpiresAt
        )
      )
    ) {
      this.invalidate(
        'replacementAuthorizedAt',
        'Replacement authorization must fall inside its authorization window',
      )
    }

    const targetSubscriptionRequired =
      this.source === 'customer' &&
      this.toPlanKey !== 'free' &&
      (
        this.status === 'old_cancellation_pending' ||
        this.status === 'scheduled' ||
        this.status === 'applying' ||
        this.status === 'applied'
      )
    if (
      targetSubscriptionRequired &&
      (!this.toSubscriptionId || !this.toRazorpaySubscriptionId)
    ) {
      this.invalidate(
        'toSubscriptionId',
        'Scheduled paid target requires replacement subscription linkage',
      )
    }
    const authorizationEvidenceRequired =
      this.toPlanKey !== 'free' &&
      (
        this.status === 'old_cancellation_pending' ||
        this.status === 'scheduled' ||
        this.status === 'applying' ||
        this.status === 'applied'
      )
    if (
      authorizationEvidenceRequired &&
      (!hasAuthorizationId || !hasAuthorizationTime)
    ) {
      this.invalidate(
        'replacementAuthorizedAt',
        'Authorized replacement state requires exact payment evidence',
      )
    }

    const hasOldCancellationAcceptance =
      this.oldCancellationAcceptedAt !== undefined
    const hasOldCancellationBoundary =
      this.oldCancellationEffectiveAt !== undefined
    if (
      hasOldCancellationAcceptance !== hasOldCancellationBoundary
    ) {
      this.invalidate(
        'oldCancellationAcceptedAt',
        'Old cancellation acceptance and boundary must be recorded together',
      )
    }
    if (
      this.oldCancellationEffectiveAt &&
      this.oldCancellationEffectiveAt.getTime() !==
        this.requestedEffectiveAt.getTime()
    ) {
      this.invalidate(
        'oldCancellationEffectiveAt',
        'Old cancellation boundary must match the promised effective time',
      )
    }
    const scheduledCancellationEvidenceRequired =
      (
        this.status === 'scheduled' ||
        this.status === 'applying' ||
        this.status === 'applied'
      ) &&
      (
        this.operation === 'tier_change' ||
        this.operation === 'period_end_cancel'
      )
    if (
      scheduledCancellationEvidenceRequired &&
      (!hasOldCancellationAcceptance || !hasOldCancellationBoundary)
    ) {
      this.invalidate(
        'oldCancellationAcceptedAt',
        'Scheduled cancellation requires exact provider boundary evidence',
      )
    }

    if (
      this.replacementTerminalVerifiedAt &&
      !this.replacementCancellationAcceptedAt
    ) {
      this.invalidate(
        'replacementTerminalVerifiedAt',
        'Replacement terminal evidence requires cancellation acceptance',
      )
    }
    if (
      (
        this.status === 'reconciling' ||
        this.status === 'compensating'
      ) &&
      !this.nextRecoveryAt
    ) {
      this.invalidate(
        'nextRecoveryAt',
        'Recoverable lifecycle states require a next attempt time',
      )
    }
    if (isTerminalStatus && this.nextRecoveryAt) {
      this.invalidate(
        'nextRecoveryAt',
        'Terminal lifecycle requests cannot remain scheduled for recovery',
      )
    }

    const expectedOutcomeByStatus: Partial<
      Record<PlanChangeRequestStatus, PlanChangeRequestOutcome[]>
    > = {
      applied: ['applied'],
      cancelled: ['cancelled', 'superseded'],
      failed: ['failed'],
    }
    const expectedOutcomes = expectedOutcomeByStatus[this.status]
    const terminal = expectedOutcomes !== undefined

    if (terminal) {
      if (
        !this.outcome ||
        !expectedOutcomes.includes(this.outcome) ||
        !this.outcomeAt ||
        !this.outcomeReason
      ) {
        this.invalidate(
          'outcome',
          'Terminal plan change status requires a matching outcome record',
        )
      }
    } else if (this.outcome || this.outcomeAt) {
      this.invalidate(
        'outcome',
        'Non-terminal plan change cannot carry a final outcome',
      )
    }

    if (this.status === 'applied' && !this.effectiveAt) {
      this.invalidate(
        'effectiveAt',
        'Applied plan change requires the actual effective time',
      )
    } else if (this.status !== 'applied' && this.effectiveAt) {
      this.invalidate(
        'effectiveAt',
        'Only an applied plan change has an actual effective time',
      )
    }
  },
)

PlanChangeRequestSchema.index(
  { userId: 1, source: 1, idempotencyKey: 1 },
  { unique: true },
)
PlanChangeRequestSchema.index(
  { activeFenceKey: 1 },
  { unique: true, sparse: true },
)
PlanChangeRequestSchema.index(
  { checkoutIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutIntentId: { $type: 'objectId' },
    },
  },
)
PlanChangeRequestSchema.index({
  userId: 1,
  status: 1,
  requestedAt: -1,
})
PlanChangeRequestSchema.index(
  {
    providerMode: 1,
    status: 1,
    nextRecoveryAt: 1,
    _id: 1,
  },
  {
    partialFilterExpression: {
      nextRecoveryAt: { $type: 'date' },
    },
  },
)
PlanChangeRequestSchema.index({
  providerMode: 1,
  fromRazorpaySubscriptionId: 1,
  requestedAt: -1,
})
PlanChangeRequestSchema.index(
  { providerMode: 1, toRazorpaySubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      toRazorpaySubscriptionId: { $type: 'string' },
    },
  },
)
PlanChangeRequestSchema.index(
  { providerMode: 1, replacementAuthorizationPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      replacementAuthorizationPaymentId: { $type: 'string' },
    },
  },
)

export const PlanChangeRequest: Model<IPlanChangeRequest> =
  mongoose.models.PlanChangeRequest ||
  mongoose.model<IPlanChangeRequest>(
    'PlanChangeRequest',
    PlanChangeRequestSchema,
  )
