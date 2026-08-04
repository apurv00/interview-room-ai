import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  FINANCIAL_LEDGER_PROVIDER_MODES,
  isNormalizedPaise,
  type FinancialLedgerProviderMode,
  type NormalizedPaise,
} from '../types'

export const FINANCIAL_OPERATION_INTENT_SCHEMA_VERSION =
  'financial_operation_intent_v1' as const

export const FINANCIAL_OPERATION_INTENT_OPERATIONS = [
  'refund',
  'exact_reconciliation',
  'credit_note',
  'access_reversal',
] as const
export type FinancialOperationIntentOperation =
  (typeof FINANCIAL_OPERATION_INTENT_OPERATIONS)[number]

export const FINANCIAL_OPERATION_REFERENCE_TYPES = [
  'payment',
  'refund',
  'invoice',
  'financial_document',
  'entitlement',
  'checkout_intent',
] as const
export type FinancialOperationReferenceType =
  (typeof FINANCIAL_OPERATION_REFERENCE_TYPES)[number]

export const FINANCIAL_OPERATION_PROVIDER_REFERENCE_TYPES = [
  'one_time_order',
  'subscription',
] as const
export type FinancialOperationProviderReferenceType =
  (typeof FINANCIAL_OPERATION_PROVIDER_REFERENCE_TYPES)[number]

export const FINANCIAL_OPERATION_INTENT_STATUSES = [
  'pending_approval',
  'approved',
  'claimed',
  'provider_uncertain',
  'observed',
  'review',
  'finalized',
] as const
export type FinancialOperationIntentStatus =
  (typeof FINANCIAL_OPERATION_INTENT_STATUSES)[number]

export const FINANCIAL_PROVIDER_OBSERVATION_OUTCOMES = [
  'succeeded',
  'failed',
  'ambiguous',
  'timeout',
] as const
export type FinancialProviderObservationOutcome =
  (typeof FINANCIAL_PROVIDER_OBSERVATION_OUTCOMES)[number]

export const FINANCIAL_OPERATION_FINAL_RESULTS = [
  'applied',
  'no_change',
] as const
export type FinancialOperationFinalResult =
  (typeof FINANCIAL_OPERATION_FINAL_RESULTS)[number]

export const FINANCIAL_OPERATION_MAX_OBSERVATIONS = 8
export const FINANCIAL_OPERATION_MIN_LEASE_MS = 5_000
export const FINANCIAL_OPERATION_MAX_LEASE_MS = 5 * 60_000

export interface IFinancialOperationTarget {
  referenceType: FinancialOperationReferenceType
  referenceId: string
  providerReference: {
    referenceType: FinancialOperationProviderReferenceType
    referenceId: string
  } | null
}

export interface IFinancialOperationAmount {
  valuePaise: NormalizedPaise
  currency: 'INR'
}

export interface IFinancialOperationApproval {
  approvedBy: string
  approvedAt: Date
  approvalDigest: string
}

export interface IFinancialOperationClaim {
  workerId: string
  fencingToken: number
  claimedAt: Date
  leaseExpiresAt: Date
  leaseDurationMs: number
}

export interface IFinancialOperationReconciliationEvidencePointer {
  manifestDigest: string
  observationRecordDigest: string
  originalClaimIdentityDigest: string
  originalFencingToken: number
  firstCommittedCheckpointVersion: number
}

export interface IFinancialProviderObservation {
  source: 'server_provider_observation_v1'
  observationId: string
  targetReference: string
  providerReference: string
  outcome: FinancialProviderObservationOutcome
  evidenceDigest: string
  attestationId: string
  attestationDigest: string
  commandDigest: string
  idempotencyKey: string
  providerMode: FinancialLedgerProviderMode
  operation: FinancialOperationIntentOperation
  amount: IFinancialOperationAmount | null
  observationDigest: string
  observedBy: string
  observedAt: Date
  verifiedAt: Date
  fencingToken: number
}

export interface IFinancialOperationFinalization {
  observationId: string
  observationDigest: string
  result: FinancialOperationFinalResult
  resultReference: string
  resultDigest: string
  localEffectAttestationId: string
  localEffectAttestationDigest: string
  commandDigest: string
  idempotencyKey: string
  providerMode: FinancialLedgerProviderMode
  operation: FinancialOperationIntentOperation
  amount: IFinancialOperationAmount | null
  verifiedAt: Date
  finalizedBy: string
  finalizedAt: Date
  finalizationDigest: string
}

export interface IFinancialOperationIntent extends Document {
  schemaVersion: typeof FINANCIAL_OPERATION_INTENT_SCHEMA_VERSION
  requestId: string
  requestDigest: string
  idempotencyDigest: string
  operation: FinancialOperationIntentOperation
  providerMode: FinancialLedgerProviderMode
  userId: string
  target: IFinancialOperationTarget
  amount: IFinancialOperationAmount | null
  correlationId: string
  requestedBy: string
  reason: string
  requestedAt: Date
  status: FinancialOperationIntentStatus
  approval?: IFinancialOperationApproval
  claim?: IFinancialOperationClaim
  checkpointVersion: number
  reconciliationEvidencePointer:
    IFinancialOperationReconciliationEvidencePointer | null
  observations: IFinancialProviderObservation[]
  observationVersion: number
  finalization?: IFinancialOperationFinalization
  createdAt: Date
  updatedAt: Date
}

const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{24}$/
const boundedString = (maximum: number, immutable = false) => ({
  type: String,
  required: true,
  trim: true,
  minlength: 1,
  maxlength: maximum,
  immutable,
})
const digestField = (immutable = false) => ({
  ...boundedString(64, immutable),
  lowercase: true,
  match: DIGEST,
})
const positiveSafeInteger = {
  validator: (value: number) =>
    Number.isSafeInteger(value) && value >= 1,
  message: '{PATH} must be a positive safe integer',
}
const objectIdString = (immutable = false) => ({
  ...boundedString(24, immutable),
  lowercase: true,
  match: OBJECT_ID,
})

const FinancialOperationTargetSchema =
  new Schema<IFinancialOperationTarget>(
    {
      referenceType: {
        type: String,
        enum: FINANCIAL_OPERATION_REFERENCE_TYPES,
        required: true,
        immutable: true,
      },
      referenceId: boundedString(255, true),
      providerReference: {
        type: new Schema(
          {
            referenceType: {
              type: String,
              enum: FINANCIAL_OPERATION_PROVIDER_REFERENCE_TYPES,
              required: true,
              immutable: true,
            },
            referenceId: boundedString(255, true),
          },
          { _id: false, strict: 'throw' },
        ),
        default: null,
        immutable: true,
      },
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationAmountSchema =
  new Schema<IFinancialOperationAmount>(
    {
      valuePaise: {
        type: Number,
        required: true,
        immutable: true,
        validate: {
          validator: (value: unknown) =>
            isNormalizedPaise(value) && value > 0,
          message: 'valuePaise must be positive safe-integer INR paise',
        },
      },
      currency: {
        type: String,
        enum: ['INR'],
        required: true,
        immutable: true,
      },
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationApprovalSchema =
  new Schema<IFinancialOperationApproval>(
    {
      approvedBy: objectIdString(),
      approvedAt: { type: Date, required: true },
      approvalDigest: digestField(),
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationClaimSchema =
  new Schema<IFinancialOperationClaim>(
    {
      workerId: boundedString(160),
      fencingToken: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
      claimedAt: { type: Date, required: true },
      leaseExpiresAt: { type: Date, required: true },
      leaseDurationMs: {
        type: Number,
        required: true,
        min: FINANCIAL_OPERATION_MIN_LEASE_MS,
        max: FINANCIAL_OPERATION_MAX_LEASE_MS,
        validate: {
          validator: Number.isSafeInteger,
          message: 'leaseDurationMs must be a safe integer',
        },
      },
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationReconciliationEvidencePointerSchema =
  new Schema<IFinancialOperationReconciliationEvidencePointer>(
    {
      manifestDigest: digestField(),
      observationRecordDigest: digestField(),
      originalClaimIdentityDigest: digestField(),
      originalFencingToken: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
      firstCommittedCheckpointVersion: {
        type: Number,
        required: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        validate: {
          validator: (value: number) =>
            Number.isSafeInteger(value) && value >= 1,
          message:
            'firstCommittedCheckpointVersion must be a positive safe integer',
        },
      },
    },
    { _id: false, strict: 'throw' },
  )

const FinancialProviderObservationSchema =
  new Schema<IFinancialProviderObservation>(
    {
      source: {
        type: String,
        enum: ['server_provider_observation_v1'],
        required: true,
      },
      observationId: boundedString(160),
      targetReference: boundedString(255),
      providerReference: boundedString(255),
      outcome: {
        type: String,
        enum: FINANCIAL_PROVIDER_OBSERVATION_OUTCOMES,
        required: true,
      },
      evidenceDigest: digestField(),
      attestationId: boundedString(160),
      attestationDigest: digestField(),
      commandDigest: digestField(),
      idempotencyKey: boundedString(100),
      providerMode: {
        type: String,
        enum: FINANCIAL_LEDGER_PROVIDER_MODES,
        required: true,
      },
      operation: {
        type: String,
        enum: FINANCIAL_OPERATION_INTENT_OPERATIONS,
        required: true,
      },
      amount: {
        type: FinancialOperationAmountSchema,
        default: null,
      },
      observationDigest: digestField(),
      observedBy: boundedString(160),
      observedAt: { type: Date, required: true },
      verifiedAt: { type: Date, required: true },
      fencingToken: {
        type: Number,
        required: true,
        validate: positiveSafeInteger,
      },
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationFinalizationSchema =
  new Schema<IFinancialOperationFinalization>(
    {
      observationId: boundedString(160),
      observationDigest: digestField(),
      result: {
        type: String,
        enum: FINANCIAL_OPERATION_FINAL_RESULTS,
        required: true,
      },
      resultReference: boundedString(255),
      resultDigest: digestField(),
      localEffectAttestationId: boundedString(160),
      localEffectAttestationDigest: digestField(),
      commandDigest: digestField(),
      idempotencyKey: boundedString(100),
      providerMode: {
        type: String,
        enum: FINANCIAL_LEDGER_PROVIDER_MODES,
        required: true,
      },
      operation: {
        type: String,
        enum: FINANCIAL_OPERATION_INTENT_OPERATIONS,
        required: true,
      },
      amount: {
        type: FinancialOperationAmountSchema,
        default: null,
      },
      verifiedAt: { type: Date, required: true },
      finalizedBy: objectIdString(),
      finalizedAt: { type: Date, required: true },
      finalizationDigest: digestField(),
    },
    { _id: false, strict: 'throw' },
  )

const FinancialOperationIntentSchema =
  new Schema<IFinancialOperationIntent>(
    {
      schemaVersion: {
        type: String,
        enum: [FINANCIAL_OPERATION_INTENT_SCHEMA_VERSION],
        required: true,
        immutable: true,
      },
      requestId: boundedString(120, true),
      requestDigest: digestField(true),
      idempotencyDigest: digestField(true),
      operation: {
        type: String,
        enum: FINANCIAL_OPERATION_INTENT_OPERATIONS,
        required: true,
        immutable: true,
      },
      providerMode: {
        type: String,
        enum: FINANCIAL_LEDGER_PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      userId: objectIdString(true),
      target: {
        type: FinancialOperationTargetSchema,
        required: true,
        immutable: true,
      },
      amount: {
        type: FinancialOperationAmountSchema,
        default: null,
        immutable: true,
      },
      correlationId: boundedString(120, true),
      requestedBy: objectIdString(true),
      reason: boundedString(500, true),
      requestedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      status: {
        type: String,
        enum: FINANCIAL_OPERATION_INTENT_STATUSES,
        required: true,
        default: 'pending_approval',
      },
      approval: { type: FinancialOperationApprovalSchema },
      claim: { type: FinancialOperationClaimSchema },
      checkpointVersion: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        validate: {
          validator: (value: number) =>
            Number.isSafeInteger(value) && value >= 0,
          message:
            'checkpointVersion must be a non-negative safe integer',
        },
      },
      reconciliationEvidencePointer: {
        type: FinancialOperationReconciliationEvidencePointerSchema,
        default: null,
      },
      observations: {
        type: [FinancialProviderObservationSchema],
        required: true,
        default: [],
        validate: {
          validator: (value: IFinancialProviderObservation[]) =>
            value.length <= FINANCIAL_OPERATION_MAX_OBSERVATIONS,
          message: 'observations exceeds its bounded history',
        },
      },
      observationVersion: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: {
          validator: Number.isSafeInteger,
          message: 'observationVersion must be a safe integer',
        },
      },
      finalization: { type: FinancialOperationFinalizationSchema },
    },
    { timestamps: true, strict: 'throw' },
  )

function requiresAmount(operation: FinancialOperationIntentOperation) {
  return operation === 'refund' || operation === 'credit_note'
}

function sameAmount(
  left: IFinancialOperationAmount | null | undefined,
  right: IFinancialOperationAmount | null | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    left.valuePaise === right.valuePaise &&
    left.currency === right.currency
  )
}

FinancialOperationIntentSchema.pre(
  'validate',
  function validateFinancialOperationIntent() {
    if (requiresAmount(this.operation) && !this.amount) {
      this.invalidate(
        'amount',
        `${this.operation} requires an exact positive INR amount`,
      )
    }
    if (this.operation === 'access_reversal' && this.amount) {
      this.invalidate(
        'amount',
        'access_reversal cannot carry a monetary amount',
      )
    }
    if (
      this.operation === 'refund' &&
      (
        this.target?.referenceType !== 'payment' ||
        this.target.providerReference
      )
    ) {
      this.invalidate(
        'target',
        'refund requires one exact captured-payment target',
      )
    }
    if (
      this.operation === 'exact_reconciliation' &&
      (
        this.target?.referenceType !== 'checkout_intent' ||
        !OBJECT_ID.test(this.target.referenceId) ||
        !this.target.providerReference ||
        this.amount
      )
    ) {
      this.invalidate(
        'target',
        'exact_reconciliation requires checkout and provider lineage',
      )
    }
    if (
      this.operation === 'access_reversal' &&
      (
        this.target?.referenceType !== 'entitlement' ||
        this.target.providerReference
      )
    ) {
      this.invalidate(
        'target.referenceType',
        'access_reversal requires an entitlement reference',
      )
    }
    if (
      this.operation === 'credit_note' &&
      (
        !['invoice', 'financial_document'].includes(
          this.target?.referenceType,
        ) ||
        Boolean(this.target?.providerReference)
      )
    ) {
      this.invalidate(
        'target.referenceType',
        'credit_note requires an invoice or financial-document reference',
      )
    }

    const hasApproval = Boolean(this.approval)
    const hasClaim = Boolean(this.claim)
    const hasFinalization = Boolean(this.finalization)
    if (
      ['pending_approval', 'approved'].includes(this.status) &&
      this.checkpointVersion !== 0
    ) {
      this.invalidate(
        'checkpointVersion',
        `${this.status} cannot contain reconciliation checkpoints`,
      )
    }
    if (
      this.reconciliationEvidencePointer &&
      this.operation !== 'exact_reconciliation'
    ) {
      this.invalidate(
        'reconciliationEvidencePointer',
        'Only exact_reconciliation can bind reconciliation evidence',
      )
    }
    if (
      this.checkpointVersion === 0 &&
      this.reconciliationEvidencePointer
    ) {
      this.invalidate(
        'reconciliationEvidencePointer',
        'An uncheckpointed intent cannot bind reconciliation evidence',
      )
    }
    if (
      this.checkpointVersion > 0 &&
      (
        this.operation !== 'exact_reconciliation' ||
        !this.reconciliationEvidencePointer
      )
    ) {
      this.invalidate(
        'checkpointVersion',
        'Every reconciliation checkpoint requires one exact evidence pointer',
      )
    }
    if (
      this.reconciliationEvidencePointer &&
      this.reconciliationEvidencePointer
        .firstCommittedCheckpointVersion >
        this.checkpointVersion
    ) {
      this.invalidate(
        'reconciliationEvidencePointer.firstCommittedCheckpointVersion',
        'Evidence cannot claim a future first committed checkpoint',
      )
    }
    if (
      this.status === 'pending_approval' &&
      (hasApproval ||
        hasClaim ||
        this.observations.length > 0 ||
        hasFinalization)
    ) {
      this.invalidate(
        'status',
        'pending_approval cannot contain later-stage evidence',
      )
    }
    if (this.status !== 'pending_approval' && !hasApproval) {
      this.invalidate('approval', `${this.status} requires approval evidence`)
    }
    if (
      !['pending_approval', 'approved'].includes(this.status) &&
      !hasClaim
    ) {
      this.invalidate('claim', `${this.status} requires claim evidence`)
    }
    if (
      this.approval &&
      this.requestedBy.trim().toLowerCase() ===
        this.approval.approvedBy.trim().toLowerCase()
    ) {
      this.invalidate(
        'approval.approvedBy',
        'requester and approver must be distinct actors',
      )
    }
    if (
      this.approval &&
      this.approval.approvedAt < this.requestedAt
    ) {
      this.invalidate(
        'approval.approvedAt',
        'approval cannot precede the request',
      )
    }
    if (this.claim && this.approval) {
      const duration =
        this.claim.leaseExpiresAt.getTime() -
        this.claim.claimedAt.getTime()
      if (
        this.claim.claimedAt < this.approval.approvedAt ||
        duration !== this.claim.leaseDurationMs
      ) {
        this.invalidate(
          'claim',
          'claim chronology or lease duration is invalid',
        )
      }
    }

    const identifiers = new Set<string>()
    const expectedTargetReference =
      this.target?.providerReference?.referenceId ??
      this.target?.referenceId
    let priorObservation: IFinancialProviderObservation | undefined
    for (const observation of this.observations) {
      if (identifiers.has(observation.observationId)) {
        this.invalidate(
          'observations',
          'observationId must be unique within an intent',
        )
        break
      }
      identifiers.add(observation.observationId)
      if (
        !this.claim ||
        observation.targetReference !== expectedTargetReference ||
        observation.providerMode !== this.providerMode ||
        observation.operation !== this.operation ||
        observation.idempotencyKey !==
          `financial_intent_v1_${this.idempotencyDigest}` ||
        !sameAmount(observation.amount, this.amount) ||
        observation.verifiedAt < observation.observedAt ||
        observation.fencingToken > this.claim.fencingToken ||
        (
          observation.fencingToken === this.claim.fencingToken &&
          observation.observedAt < this.claim.claimedAt
        ) ||
        (
          priorObservation &&
          (
            observation.fencingToken <
              priorObservation.fencingToken ||
            observation.observedAt <
              priorObservation.observedAt ||
            observation.verifiedAt <
              priorObservation.verifiedAt
          )
        )
      ) {
        this.invalidate(
          'observations',
          'provider observation does not match the active claim fence',
        )
        break
      }
      priorObservation = observation
    }
    if (this.observationVersion !== this.observations.length) {
      this.invalidate(
        'observationVersion',
        'observationVersion must equal the append-only history length',
      )
    }
    const lastObservation =
      this.observations[this.observations.length - 1]
    const isConclusive = lastObservation &&
      ['succeeded', 'failed'].includes(lastObservation.outcome)
    if (
      lastObservation &&
      this.status !== 'claimed' &&
      lastObservation.fencingToken !== this.claim?.fencingToken
    ) {
      this.invalidate(
        'observations',
        `${this.status} must bind its latest provider evidence to the current fence`,
      )
    }
    if (
      ['observed', 'finalized'].includes(this.status) &&
      !isConclusive
    ) {
      this.invalidate(
        'observations',
        `${this.status} requires a conclusive provider observation`,
      )
    }
    if (
      ['provider_uncertain', 'review'].includes(this.status) &&
      (!lastObservation ||
        !['ambiguous', 'timeout'].includes(lastObservation.outcome))
    ) {
      this.invalidate(
        'observations',
        `${this.status} requires uncertain provider evidence`,
      )
    }
    if (this.status === 'finalized' && !hasFinalization) {
      this.invalidate(
        'finalization',
        'finalized requires local completion evidence',
      )
    }
    if (this.status !== 'finalized' && hasFinalization) {
      this.invalidate(
        'finalization',
        'finalization evidence is valid only in finalized state',
      )
    }
    if (this.finalization) {
      const observed = this.observations.find(
        (entry) =>
          entry.observationId === this.finalization?.observationId,
      )
      if (
        !observed ||
        observed.observationDigest !==
          this.finalization.observationDigest ||
        observed.commandDigest !== this.finalization.commandDigest ||
        observed.idempotencyKey !== this.finalization.idempotencyKey ||
        observed.providerMode !== this.finalization.providerMode ||
        observed.operation !== this.finalization.operation ||
        !sameAmount(observed.amount, this.finalization.amount) ||
        !['succeeded', 'failed'].includes(observed.outcome) ||
        (
          observed.outcome === 'failed' &&
          this.finalization.result === 'applied'
        ) ||
        this.finalization.verifiedAt < observed.verifiedAt ||
        this.finalization.finalizedAt <
          this.finalization.verifiedAt ||
        this.finalization.finalizedAt < observed.observedAt
      ) {
        this.invalidate(
          'finalization',
          'finalization does not bind exact conclusive observation evidence',
        )
      }
    }
  },
)

FinancialOperationIntentSchema.index(
  { providerMode: 1, requestId: 1 },
  { unique: true },
)
FinancialOperationIntentSchema.index(
  { providerMode: 1, idempotencyDigest: 1 },
  { unique: true },
)
FinancialOperationIntentSchema.index(
  { providerMode: 1, 'observations.observationId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'observations.observationId': { $type: 'string' },
    },
  },
)
FinancialOperationIntentSchema.index({
  status: 1,
  'claim.leaseExpiresAt': 1,
})
FinancialOperationIntentSchema.index({
  providerMode: 1,
  operation: 1,
  'target.referenceType': 1,
  'target.referenceId': 1,
  status: 1,
})
FinancialOperationIntentSchema.index({ userId: 1, createdAt: -1 })

export const FinancialOperationIntent: Model<IFinancialOperationIntent> =
  mongoose.models.FinancialOperationIntent ||
  mongoose.model<IFinancialOperationIntent>(
    'FinancialOperationIntent',
    FinancialOperationIntentSchema,
  )
