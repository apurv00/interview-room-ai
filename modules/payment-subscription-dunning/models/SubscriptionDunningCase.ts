import { createHash } from 'node:crypto'
import mongoose, {
  type Document,
  type Model,
  Schema,
} from 'mongoose'
import {
  SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES,
  SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_CLASSIFICATIONS,
  SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES,
  SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_STATES,
  SUBSCRIPTION_DUNNING_PROVISIONAL_TERMINAL_OUTCOMES,
  SUBSCRIPTION_DUNNING_PROVIDER_MODES,
  SUBSCRIPTION_DUNNING_PROVIDER_STATUSES,
  SUBSCRIPTION_DUNNING_PROVISIONAL_STATES,
  SUBSCRIPTION_DUNNING_REASON_CODES,
  SubscriptionDunningProvisionalGrantSchema,
  provisionalInterviewStateFromGrant,
  type SubscriptionDunningAccessOverride,
  type SubscriptionDunningClassification,
  type SubscriptionDunningClockAuthority,
  type SubscriptionDunningProviderMode,
  type SubscriptionDunningProviderStatus,
  type SubscriptionDunningProvisionalGrant,
  type SubscriptionDunningProvisionalGrantState,
  type SubscriptionDunningProvisionalState,
  type SubscriptionDunningProvisionalTerminalOutcome,
  type SubscriptionDunningReasonCode,
} from '../contracts'

const DIGEST = /^[a-f0-9]{64}$/

interface ISubscriptionDunningCapturedTargetCycle {
  cycleId: mongoose.Types.ObjectId
  subscriptionId: mongoose.Types.ObjectId
  paidPeriodKey: string
  capturedAt: Date
  evidenceDigest: string
}

interface ISubscriptionDunningProvisionalGrant {
  schemaVersion:
    typeof SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION
  grantId: mongoose.Types.ObjectId
  revision: number
  state: SubscriptionDunningProvisionalGrantState
  originStatusVersion: number
  lastStatusVersion: number
  offeredAt: Date
  reservedSessionId: mongoose.Types.ObjectId | null
  usageReferenceId: mongoose.Types.ObjectId | null
  reservedAt: Date | null
  consumedAt: Date | null
  terminalOutcome:
    SubscriptionDunningProvisionalTerminalOutcome | null
  finalizedAt: Date | null
  capturedTargetCycle:
    ISubscriptionDunningCapturedTargetCycle | null
  offerEvidenceDigest: string
  lastEvidenceDigest: string
  lastCommandDigest: string
  grantDigest: string
}

export interface ISubscriptionDunningCase extends Document {
  schemaVersion:
    typeof SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION
  policyVersion: typeof SUBSCRIPTION_DUNNING_POLICY_VERSION
  providerMode: SubscriptionDunningProviderMode
  subscriptionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  paidPeriodKey: string
  paidPeriodStart: Date
  paidPeriodEnd: Date
  providerStatus: SubscriptionDunningProviderStatus
  statusVersion: number | null
  clockAuthority: SubscriptionDunningClockAuthority
  statusObservedAt: Date
  firstPendingObservedAt: Date | null
  remoteRetryingConfirmed: boolean
  renewalCycleCaptured: boolean
  accessOverride: SubscriptionDunningAccessOverride
  sourceEvidenceDigest: string
  classification: SubscriptionDunningClassification
  reason: SubscriptionDunningReasonCode
  configuredGraceMs: number
  graceEndsAt: Date | null
  nextActionAt: Date | null
  provisionalGrant:
    ISubscriptionDunningProvisionalGrant | null
  provisionalInterviewState:
    SubscriptionDunningProvisionalState
  revision: number
  lastEventSequence: number
  decisionDigest: string
  attemptCount: number
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  lastErrorCode: string | null
  createdAt: Date
  updatedAt: Date
}

function boundedCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(record[key])}`,
    ).join(',')}}`
  }
  return ''
}

function exactGrantDigest(
  grant: SubscriptionDunningProvisionalGrant,
): string {
  const { grantDigest: _storedDigest, ...authority } = grant
  return createHash('sha256')
    .update(canonical(authority))
    .digest('hex')
}

const SubscriptionDunningCapturedTargetCycleSchema =
  new Schema<ISubscriptionDunningCapturedTargetCycle>(
    {
      cycleId: {
        type: Schema.Types.ObjectId,
        ref: 'SubscriptionCycle',
        required: true,
        immutable: true,
      },
      subscriptionId: {
        type: Schema.Types.ObjectId,
        ref: 'PaymentSubscription',
        required: true,
        immutable: true,
      },
      paidPeriodKey: {
        type: String,
        required: true,
        trim: true,
        maxlength: 255,
        immutable: true,
      },
      capturedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      evidenceDigest: {
        type: String,
        required: true,
        match: DIGEST,
        immutable: true,
      },
    },
    { _id: false },
  )

const SubscriptionDunningProvisionalGrantSubdocumentSchema =
  new Schema<ISubscriptionDunningProvisionalGrant>(
    {
      schemaVersion: {
        type: String,
        enum: [
          SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_SCHEMA_VERSION,
        ],
        required: true,
        immutable: true,
      },
      grantId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      revision: { type: Number, required: true, min: 1 },
      state: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVISIONAL_GRANT_STATES,
        required: true,
      },
      originStatusVersion: {
        type: Number,
        required: true,
        min: 0,
        immutable: true,
      },
      lastStatusVersion: {
        type: Number,
        required: true,
        min: 0,
      },
      offeredAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      reservedSessionId: {
        type: Schema.Types.ObjectId,
        default: null,
      },
      usageReferenceId: {
        type: Schema.Types.ObjectId,
        default: null,
      },
      reservedAt: { type: Date, default: null },
      consumedAt: { type: Date, default: null },
      terminalOutcome: {
        type: String,
        enum: [
          ...SUBSCRIPTION_DUNNING_PROVISIONAL_TERMINAL_OUTCOMES,
          null,
        ],
        default: null,
      },
      finalizedAt: { type: Date, default: null },
      capturedTargetCycle: {
        type: SubscriptionDunningCapturedTargetCycleSchema,
        default: null,
      },
      offerEvidenceDigest: {
        type: String,
        required: true,
        match: DIGEST,
        immutable: true,
      },
      lastEvidenceDigest: {
        type: String,
        required: true,
        match: DIGEST,
      },
      lastCommandDigest: {
        type: String,
        required: true,
        match: DIGEST,
      },
      grantDigest: {
        type: String,
        required: true,
        match: DIGEST,
      },
    },
    { _id: false },
  )

const SubscriptionDunningCaseSchema =
  new Schema<ISubscriptionDunningCase>(
    {
      schemaVersion: {
        type: String,
        enum: [SUBSCRIPTION_DUNNING_CASE_SCHEMA_VERSION],
        required: true,
        immutable: true,
      },
      policyVersion: {
        type: String,
        enum: [SUBSCRIPTION_DUNNING_POLICY_VERSION],
        required: true,
      },
      providerMode: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      subscriptionId: {
        type: Schema.Types.ObjectId,
        ref: 'PaymentSubscription',
        required: true,
        immutable: true,
      },
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
      },
      paidPeriodKey: {
        type: String,
        required: true,
        trim: true,
        maxlength: 255,
        immutable: true,
      },
      paidPeriodStart: {
        type: Date,
        required: true,
        immutable: true,
      },
      paidPeriodEnd: {
        type: Date,
        required: true,
        immutable: true,
      },
      providerStatus: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVIDER_STATUSES,
        required: true,
      },
      statusVersion: {
        type: Number,
        default: null,
      },
      clockAuthority: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_CLOCK_AUTHORITIES,
        required: true,
      },
      statusObservedAt: { type: Date, required: true },
      firstPendingObservedAt: { type: Date, default: null },
      remoteRetryingConfirmed: {
        type: Boolean,
        required: true,
      },
      renewalCycleCaptured: {
        type: Boolean,
        required: true,
      },
      accessOverride: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_ACCESS_OVERRIDES,
        required: true,
      },
      sourceEvidenceDigest: {
        type: String,
        required: true,
        match: DIGEST,
      },
      classification: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_CLASSIFICATIONS,
        required: true,
      },
      reason: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_REASON_CODES,
        required: true,
      },
      configuredGraceMs: {
        type: Number,
        required: true,
        min: 0,
        max: SUBSCRIPTION_DUNNING_MAX_GRACE_MS,
      },
      graceEndsAt: { type: Date, default: null },
      nextActionAt: { type: Date, default: null },
      provisionalGrant: {
        type: SubscriptionDunningProvisionalGrantSubdocumentSchema,
        default: null,
      },
      provisionalInterviewState: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVISIONAL_STATES,
        required: true,
        default: 'not_offered',
      },
      revision: {
        type: Number,
        required: true,
        min: 1,
      },
      lastEventSequence: {
        type: Number,
        required: true,
        min: 1,
      },
      decisionDigest: {
        type: String,
        required: true,
        match: DIGEST,
      },
      attemptCount: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
      leaseOwner: {
        type: String,
        trim: true,
        maxlength: 160,
        default: null,
      },
      leaseExpiresAt: { type: Date, default: null },
      lastErrorCode: {
        type: String,
        trim: true,
        maxlength: 100,
        default: null,
      },
    },
    { timestamps: true },
  )

SubscriptionDunningCaseSchema.index(
  {
    providerMode: 1,
    subscriptionId: 1,
    paidPeriodKey: 1,
  },
  {
    unique: true,
    name: 'uq_subscription_dunning_case_period_v1',
  },
)
SubscriptionDunningCaseSchema.index(
  {
    providerMode: 1,
    nextActionAt: 1,
    _id: 1,
  },
  { name: 'subscription_dunning_due_scan_v2' },
)
SubscriptionDunningCaseSchema.index(
  { userId: 1, providerMode: 1, updatedAt: -1 },
  { name: 'subscription_dunning_user_read_v1' },
)

SubscriptionDunningCaseSchema.pre(
  'validate',
  function validateDunningCase() {
    if (this.paidPeriodEnd <= this.paidPeriodStart) {
      this.invalidate(
        'paidPeriodEnd',
        'Paid period end must follow its start',
      )
    }
    const authoritative =
      this.clockAuthority === 'authoritative'
    if (
      authoritative !== (
        boundedCounter(this.statusVersion as number) &&
        this.statusVersion !== null
      )
    ) {
      this.invalidate(
        'statusVersion',
        'Only authoritative cases carry a status version',
      )
    }
    if (
      this.clockAuthority === 'legacy_unknown' &&
      (
        this.classification !== 'review' ||
        this.reason !== 'legacy_clock_unknown' ||
        this.firstPendingObservedAt !== null ||
        this.remoteRetryingConfirmed ||
        this.renewalCycleCaptured
      )
    ) {
      this.invalidate(
        'clockAuthority',
        'Legacy case authority must remain review-only',
      )
    }
    if (
      this.statusObservedAt < this.paidPeriodStart ||
      (
        this.firstPendingObservedAt !== null &&
        this.firstPendingObservedAt > this.statusObservedAt
      )
    ) {
      this.invalidate(
        'statusObservedAt',
        'Dunning observation clock is inconsistent',
      )
    }
    if (
      !boundedCounter(this.configuredGraceMs) ||
      this.configuredGraceMs >
        SUBSCRIPTION_DUNNING_MAX_GRACE_MS
    ) {
      this.invalidate(
        'configuredGraceMs',
        'Configured grace exceeds its exact bound',
      )
    }
    if (
      this.graceEndsAt !== null &&
      this.graceEndsAt.getTime() !==
        this.paidPeriodEnd.getTime() +
          this.configuredGraceMs
    ) {
      this.invalidate(
        'graceEndsAt',
        'Grace must begin exactly at paid period end',
      )
    }
    if (
      !Number.isSafeInteger(this.revision) ||
      this.revision < 1 ||
      !Number.isSafeInteger(this.lastEventSequence) ||
      this.lastEventSequence < 1 ||
      !boundedCounter(this.attemptCount)
    ) {
      this.invalidate(
        'revision',
        'Dunning counters must be bounded integers',
      )
    }
    if (
      (this.leaseOwner === null) !==
        (this.leaseExpiresAt === null)
    ) {
      this.invalidate(
        'leaseOwner',
        'Dunning lease authority must be a complete pair',
      )
    }
    const rawGrant = this.provisionalGrant
    const parsedGrant = rawGrant === null
      ? null
      : SubscriptionDunningProvisionalGrantSchema.safeParse({
          schemaVersion: rawGrant.schemaVersion,
          grantId: rawGrant.grantId.toString(),
          revision: rawGrant.revision,
          state: rawGrant.state,
          originStatusVersion: rawGrant.originStatusVersion,
          lastStatusVersion: rawGrant.lastStatusVersion,
          offeredAt: rawGrant.offeredAt.toISOString(),
          reservedSessionId:
            rawGrant.reservedSessionId?.toString() ?? null,
          usageReferenceId:
            rawGrant.usageReferenceId?.toString() ?? null,
          reservedAt: rawGrant.reservedAt?.toISOString() ?? null,
          consumedAt: rawGrant.consumedAt?.toISOString() ?? null,
          terminalOutcome: rawGrant.terminalOutcome,
          finalizedAt:
            rawGrant.finalizedAt?.toISOString() ?? null,
          capturedTargetCycle: rawGrant.capturedTargetCycle
            ? {
                cycleId:
                  rawGrant.capturedTargetCycle.cycleId.toString(),
                subscriptionId:
                  rawGrant.capturedTargetCycle.subscriptionId
                    .toString(),
                paidPeriodKey:
                  rawGrant.capturedTargetCycle.paidPeriodKey,
                capturedAt:
                  rawGrant.capturedTargetCycle.capturedAt
                    .toISOString(),
                evidenceDigest:
                  rawGrant.capturedTargetCycle.evidenceDigest,
              }
            : null,
          offerEvidenceDigest: rawGrant.offerEvidenceDigest,
          lastEvidenceDigest: rawGrant.lastEvidenceDigest,
          lastCommandDigest: rawGrant.lastCommandDigest,
          grantDigest: rawGrant.grantDigest,
        })
    const grant = parsedGrant === null
      ? null
      : parsedGrant.success
        ? parsedGrant.data as SubscriptionDunningProvisionalGrant
        : null
    if (
      (parsedGrant !== null && !parsedGrant.success) ||
      (
        grant !== null &&
        exactGrantDigest(grant) !== grant.grantDigest
      ) ||
      this.provisionalInterviewState !==
        provisionalInterviewStateFromGrant(grant)
    ) {
      this.invalidate(
        'provisionalGrant',
        'Provisional interview summary must derive from one valid grant',
      )
    }
  },
)

export const SubscriptionDunningCase:
  Model<ISubscriptionDunningCase> =
    (mongoose.models.PaymentSubscriptionDunningCase as
      Model<ISubscriptionDunningCase> | undefined) ??
    mongoose.model<ISubscriptionDunningCase>(
      'PaymentSubscriptionDunningCase',
      SubscriptionDunningCaseSchema,
    )
