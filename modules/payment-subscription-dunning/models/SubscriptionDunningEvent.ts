import mongoose, {
  type Document,
  type Model,
  Schema,
} from 'mongoose'
import {
  SUBSCRIPTION_DUNNING_CLASSIFICATIONS,
  SUBSCRIPTION_DUNNING_EVENT_KINDS,
  SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION,
  SUBSCRIPTION_DUNNING_POLICY_VERSION,
  SUBSCRIPTION_DUNNING_PROVIDER_MODES,
  SUBSCRIPTION_DUNNING_PROVIDER_STATUSES,
  SUBSCRIPTION_DUNNING_REASON_CODES,
  type SubscriptionDunningClassification,
  type SubscriptionDunningEventKind,
  type SubscriptionDunningProviderMode,
  type SubscriptionDunningProviderStatus,
  type SubscriptionDunningReasonCode,
} from '../contracts'

const DIGEST = /^[a-f0-9]{64}$/

export interface ISubscriptionDunningEvent extends Document {
  schemaVersion:
    typeof SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION
  policyVersion: typeof SUBSCRIPTION_DUNNING_POLICY_VERSION
  caseId: mongoose.Types.ObjectId
  sequence: number
  kind: SubscriptionDunningEventKind
  providerMode: SubscriptionDunningProviderMode
  providerStatus: SubscriptionDunningProviderStatus
  statusVersion: number | null
  priorClassification:
    SubscriptionDunningClassification | null
  classification: SubscriptionDunningClassification
  reason: SubscriptionDunningReasonCode
  occurredAt: Date
  sourceEvidenceDigest: string
  decisionDigest: string
  eventDigest: string
  createdAt: Date
}

const SubscriptionDunningEventSchema =
  new Schema<ISubscriptionDunningEvent>(
    {
      schemaVersion: {
        type: String,
        enum: [SUBSCRIPTION_DUNNING_EVENT_SCHEMA_VERSION],
        required: true,
        immutable: true,
      },
      policyVersion: {
        type: String,
        enum: [SUBSCRIPTION_DUNNING_POLICY_VERSION],
        required: true,
        immutable: true,
      },
      caseId: {
        type: Schema.Types.ObjectId,
        ref: 'PaymentSubscriptionDunningCase',
        required: true,
        immutable: true,
      },
      sequence: {
        type: Number,
        required: true,
        min: 1,
        immutable: true,
      },
      kind: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_EVENT_KINDS,
        required: true,
        immutable: true,
      },
      providerMode: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      providerStatus: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_PROVIDER_STATUSES,
        required: true,
        immutable: true,
      },
      statusVersion: {
        type: Number,
        default: null,
        immutable: true,
      },
      priorClassification: {
        type: String,
        enum: [...SUBSCRIPTION_DUNNING_CLASSIFICATIONS, null],
        default: null,
        immutable: true,
      },
      classification: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_CLASSIFICATIONS,
        required: true,
        immutable: true,
      },
      reason: {
        type: String,
        enum: SUBSCRIPTION_DUNNING_REASON_CODES,
        required: true,
        immutable: true,
      },
      occurredAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      sourceEvidenceDigest: {
        type: String,
        required: true,
        match: DIGEST,
        immutable: true,
      },
      decisionDigest: {
        type: String,
        required: true,
        match: DIGEST,
        immutable: true,
      },
      eventDigest: {
        type: String,
        required: true,
        match: DIGEST,
        immutable: true,
      },
    },
    {
      timestamps: { createdAt: true, updatedAt: false },
    },
  )

SubscriptionDunningEventSchema.index(
  { caseId: 1, sequence: 1 },
  {
    unique: true,
    name: 'uq_subscription_dunning_event_sequence_v1',
  },
)
SubscriptionDunningEventSchema.index(
  { caseId: 1, eventDigest: 1 },
  {
    unique: true,
    name: 'uq_subscription_dunning_event_digest_v1',
  },
)
SubscriptionDunningEventSchema.index(
  { providerMode: 1, occurredAt: -1, _id: -1 },
  { name: 'subscription_dunning_event_audit_v1' },
)

SubscriptionDunningEventSchema.pre(
  'validate',
  function validateDunningEvent() {
    if (
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1 ||
      (
        this.statusVersion !== null &&
        (
          !Number.isSafeInteger(this.statusVersion) ||
          this.statusVersion < 0
        )
      )
    ) {
      this.invalidate(
        'sequence',
        'Dunning event versions must be bounded integers',
      )
    }
  },
)

export const SubscriptionDunningEvent:
  Model<ISubscriptionDunningEvent> =
    (mongoose.models.PaymentSubscriptionDunningEvent as
      Model<ISubscriptionDunningEvent> | undefined) ??
    mongoose.model<ISubscriptionDunningEvent>(
      'PaymentSubscriptionDunningEvent',
      SubscriptionDunningEventSchema,
    )
