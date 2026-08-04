import mongoose, {
  type InferSchemaType,
  type Model,
  Schema,
} from 'mongoose'
import {
  BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION,
  BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION,
  BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION,
  BILLING_ROLLOUT_OWNER_ROLES,
  BILLING_ROLLOUT_PHASE_IDS,
  BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION,
} from './contracts'

const DIGEST = /^[a-f0-9]{64}$/
const digest = (immutable = true, nullable = false) => ({
  type: String,
  required: !nullable,
  default: nullable ? null : undefined,
  immutable,
  minlength: 64,
  maxlength: 64,
  lowercase: true,
  match: DIGEST,
})
const boundedInteger = (
  minimum: number,
  maximum: number,
  immutable = false,
) => ({
  type: Number,
  required: true,
  min: minimum,
  max: maximum,
  immutable,
  validate: {
    validator: (value: number) =>
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    message: '{PATH} must be a bounded safe integer',
  },
})

const BillingRolloutPhaseRequestRecordSchema = new Schema(
  {
    _id: digest(),
    singletonKey: {
      type: String,
      enum: ['billing-rollout'],
      required: true,
      immutable: true,
    },
    schemaVersion: {
      type: String,
      enum: [BILLING_ROLLOUT_PHASE_REQUEST_SCHEMA_VERSION],
      required: true,
      immutable: true,
    },
    commandId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    correlationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    phaseId: {
      type: String,
      enum: BILLING_ROLLOUT_PHASE_IDS,
      required: true,
      immutable: true,
    },
    requestDigest: digest(),
    requestCanonicalJson: {
      type: String,
      required: true,
      immutable: true,
      minlength: 2,
      maxlength: 256_000,
    },
    requestedStateHash: digest(),
    evidenceBundleHash: digest(),
    requesterUserId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    requesterCmsRole: {
      type: String,
      enum: ['platform_admin'],
      required: true,
      immutable: true,
    },
    requiredApprovalRoles: {
      type: [String],
      enum: BILLING_ROLLOUT_OWNER_ROLES,
      required: true,
      immutable: true,
      validate: {
        validator: (values: string[]) =>
          values.length >= 3 &&
          values.length <= BILLING_ROLLOUT_OWNER_ROLES.length &&
          values.every(
            (value, index) =>
              index === 0 || values[index - 1]! < value,
          ),
        message: 'Required approval roles must be unique and sorted',
      },
    },
    expectedAuthorityRevision: boundedInteger(
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    expectedCurrentActivationSequence: boundedInteger(
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    expectedConfigRevision: boundedInteger(
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    configBeforeHash: digest(),
    configAfterPreviewHash: digest(),
    notBefore: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: [
        'pending_approval',
        'approved',
        'rejected',
        'activated',
        'expired',
        'superseded',
      ],
      required: true,
    },
    revision: boundedInteger(1, Number.MAX_SAFE_INTEGER),
  },
  {
    collection: 'billingrolloutphaserequests',
    timestamps: { createdAt: true, updatedAt: true },
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)

BillingRolloutPhaseRequestRecordSchema.index(
  { commandId: 1 },
  { unique: true },
)
BillingRolloutPhaseRequestRecordSchema.index(
  { requestDigest: 1 },
  { unique: true },
)
BillingRolloutPhaseRequestRecordSchema.index({
  status: 1,
  expiresAt: 1,
  _id: 1,
})
BillingRolloutPhaseRequestRecordSchema.index({
  phaseId: 1,
  createdAt: -1,
  _id: -1,
})
BillingRolloutPhaseRequestRecordSchema.index(
  { singletonKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['pending_approval', 'approved'] },
    },
  },
)

const BillingRolloutApprovalRecordSchema = new Schema(
  {
    _id: digest(),
    schemaVersion: {
      type: String,
      enum: [BILLING_ROLLOUT_APPROVAL_SCHEMA_VERSION],
      required: true,
      immutable: true,
    },
    commandId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    correlationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    requestId: digest(),
    requestDigest: digest(),
    ownerRole: {
      type: String,
      enum: BILLING_ROLLOUT_OWNER_ROLES,
      required: true,
      immutable: true,
    },
    decision: {
      type: String,
      enum: ['approved', 'rejected'],
      required: true,
      immutable: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    actorCmsRole: {
      type: String,
      enum: ['platform_admin'],
      required: true,
      immutable: true,
    },
    reason: {
      type: String,
      required: true,
      immutable: true,
      minlength: 20,
      maxlength: 2_000,
    },
    recordedAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: 'billingrolloutapprovals',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)

BillingRolloutApprovalRecordSchema.index(
  { commandId: 1 },
  { unique: true },
)
BillingRolloutApprovalRecordSchema.index(
  { requestId: 1, ownerRole: 1 },
  { unique: true },
)
BillingRolloutApprovalRecordSchema.index({
  requestId: 1,
  recordedAt: 1,
  _id: 1,
})

function rejectApprovalMutation(): never {
  throw new Error('BillingRolloutApprovalRecord is append-only')
}

BillingRolloutApprovalRecordSchema.pre(
  'updateOne',
  rejectApprovalMutation,
)
BillingRolloutApprovalRecordSchema.pre(
  'updateMany',
  rejectApprovalMutation,
)
BillingRolloutApprovalRecordSchema.pre(
  'findOneAndUpdate',
  rejectApprovalMutation,
)
BillingRolloutApprovalRecordSchema.pre(
  'replaceOne',
  rejectApprovalMutation,
)
BillingRolloutApprovalRecordSchema.pre(
  'deleteOne',
  rejectApprovalMutation,
)
BillingRolloutApprovalRecordSchema.pre(
  'deleteMany',
  rejectApprovalMutation,
)

const BillingRolloutActivationRecordSchema = new Schema(
  {
    _id: digest(),
    schemaVersion: {
      type: String,
      enum: [BILLING_ROLLOUT_ACTIVATION_SCHEMA_VERSION],
      required: true,
      immutable: true,
    },
    commandId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    correlationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    sequence: boundedInteger(1, Number.MAX_SAFE_INTEGER, true),
    authorityRevision: boundedInteger(1, Number.MAX_SAFE_INTEGER, true),
    stopEpoch: boundedInteger(0, Number.MAX_SAFE_INTEGER, true),
    phaseId: {
      type: String,
      enum: BILLING_ROLLOUT_PHASE_IDS,
      required: true,
      immutable: true,
    },
    requestId: digest(),
    requestDigest: digest(),
    requestedStateHash: digest(),
    configBeforeHash: digest(),
    configAfterHash: digest(),
    configRevision: boundedInteger(1, Number.MAX_SAFE_INTEGER, true),
    deploymentId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    commitSha: {
      type: String,
      required: true,
      immutable: true,
      minlength: 7,
      maxlength: 64,
    },
    activeCatalogVersion: {
      type: String,
      required: true,
      immutable: true,
      minlength: 1,
      maxlength: 120,
    },
    activeCatalogHash: digest(),
    providerBindingHash: digest(),
    couponPolicyHash: digest(),
    copyBundleHash: digest(),
    rolloutPolicyHash: digest(),
    cohortOrAllowlistHash: digest(),
    cohortContinuityHash: digest(),
    recoveryPreserved: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'Recovery preservation must be true',
      },
    },
    activatedByUserId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    activatedAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: 'billingrolloutactivations',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)

BillingRolloutActivationRecordSchema.index(
  { sequence: 1 },
  { unique: true },
)
BillingRolloutActivationRecordSchema.index(
  { commandId: 1 },
  { unique: true },
)
BillingRolloutActivationRecordSchema.index(
  { requestId: 1 },
  { unique: true },
)
BillingRolloutActivationRecordSchema.index({
  phaseId: 1,
  activatedAt: -1,
  _id: -1,
})

function rejectActivationMutation(): never {
  throw new Error('BillingRolloutActivationRecord is append-only')
}

BillingRolloutActivationRecordSchema.pre(
  'updateOne',
  rejectActivationMutation,
)
BillingRolloutActivationRecordSchema.pre(
  'updateMany',
  rejectActivationMutation,
)
BillingRolloutActivationRecordSchema.pre(
  'findOneAndUpdate',
  rejectActivationMutation,
)
BillingRolloutActivationRecordSchema.pre(
  'replaceOne',
  rejectActivationMutation,
)
BillingRolloutActivationRecordSchema.pre(
  'deleteOne',
  rejectActivationMutation,
)
BillingRolloutActivationRecordSchema.pre(
  'deleteMany',
  rejectActivationMutation,
)

const BillingRolloutAuthorityRecordSchema = new Schema(
  {
    key: {
      type: String,
      enum: ['singleton'],
      required: true,
      default: 'singleton',
      immutable: true,
    },
    revision: boundedInteger(0, Number.MAX_SAFE_INTEGER),
    currentActivationSequence: boundedInteger(
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    activeActivationId: digest(false, true),
    lastActivationId: digest(false, true),
    stopEpoch: boundedInteger(0, Number.MAX_SAFE_INTEGER),
    state: {
      type: String,
      enum: ['inert', 'active', 'stopped'],
      required: true,
    },
    updatedByUserId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
  },
  {
    collection: 'billingrolloutauthorities',
    timestamps: true,
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)

BillingRolloutAuthorityRecordSchema.index(
  { key: 1 },
  { unique: true },
)

const BillingRolloutEmergencyStopRecordSchema = new Schema(
  {
    _id: digest(),
    schemaVersion: {
      type: String,
      enum: [BILLING_ROLLOUT_EMERGENCY_STOP_SCHEMA_VERSION],
      required: true,
      immutable: true,
    },
    commandId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    correlationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    stopEpoch: boundedInteger(1, Number.MAX_SAFE_INTEGER, true),
    authorityRevision: boundedInteger(1, Number.MAX_SAFE_INTEGER, true),
    previousActivationId: digest(),
    previousActivationSequence: boundedInteger(
      1,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    incidentReference: {
      type: String,
      required: true,
      immutable: true,
      minlength: 3,
      maxlength: 200,
    },
    reason: {
      type: String,
      required: true,
      immutable: true,
      minlength: 20,
      maxlength: 2_000,
    },
    configBeforeHash: digest(),
    configAfterHash: digest(),
    webhookProcessingPreserved: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'Webhook processing preservation must be true',
      },
    },
    reconciliationPreserved: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: (value: boolean) => value === true,
        message: 'Reconciliation preservation must be true',
      },
    },
    stoppedByUserId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    stoppedAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: 'billingrolloutemergencystops',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    versionKey: false,
    writeConcern: { w: 'majority', j: true },
  },
)

BillingRolloutEmergencyStopRecordSchema.index(
  { stopEpoch: 1 },
  { unique: true },
)
BillingRolloutEmergencyStopRecordSchema.index(
  { commandId: 1 },
  { unique: true },
)
BillingRolloutEmergencyStopRecordSchema.index({
  previousActivationId: 1,
  stoppedAt: -1,
})

function rejectStopMutation(): never {
  throw new Error('BillingRolloutEmergencyStopRecord is append-only')
}

BillingRolloutEmergencyStopRecordSchema.pre(
  'updateOne',
  rejectStopMutation,
)
BillingRolloutEmergencyStopRecordSchema.pre(
  'updateMany',
  rejectStopMutation,
)
BillingRolloutEmergencyStopRecordSchema.pre(
  'findOneAndUpdate',
  rejectStopMutation,
)
BillingRolloutEmergencyStopRecordSchema.pre(
  'replaceOne',
  rejectStopMutation,
)
BillingRolloutEmergencyStopRecordSchema.pre(
  'deleteOne',
  rejectStopMutation,
)
BillingRolloutEmergencyStopRecordSchema.pre(
  'deleteMany',
  rejectStopMutation,
)

export type BillingRolloutPhaseRequestRecord =
  InferSchemaType<typeof BillingRolloutPhaseRequestRecordSchema>
export type BillingRolloutApprovalRecord =
  InferSchemaType<typeof BillingRolloutApprovalRecordSchema>
export type BillingRolloutActivationRecord =
  InferSchemaType<typeof BillingRolloutActivationRecordSchema>
export type BillingRolloutAuthorityRecord =
  InferSchemaType<typeof BillingRolloutAuthorityRecordSchema>
export type BillingRolloutEmergencyStopRecord =
  InferSchemaType<typeof BillingRolloutEmergencyStopRecordSchema>

export const BillingRolloutPhaseRequestModel: Model<
  BillingRolloutPhaseRequestRecord
> = mongoose.models.BillingRolloutPhaseRequest ??
  mongoose.model(
    'BillingRolloutPhaseRequest',
    BillingRolloutPhaseRequestRecordSchema,
  )

export const BillingRolloutApprovalModel: Model<
  BillingRolloutApprovalRecord
> = mongoose.models.BillingRolloutApproval ??
  mongoose.model(
    'BillingRolloutApproval',
    BillingRolloutApprovalRecordSchema,
  )

export const BillingRolloutActivationModel: Model<
  BillingRolloutActivationRecord
> = mongoose.models.BillingRolloutActivation ??
  mongoose.model(
    'BillingRolloutActivation',
    BillingRolloutActivationRecordSchema,
  )

export const BillingRolloutAuthorityModel: Model<
  BillingRolloutAuthorityRecord
> = mongoose.models.BillingRolloutAuthority ??
  mongoose.model(
    'BillingRolloutAuthority',
    BillingRolloutAuthorityRecordSchema,
  )

export const BillingRolloutEmergencyStopModel: Model<
  BillingRolloutEmergencyStopRecord
> = mongoose.models.BillingRolloutEmergencyStop ??
  mongoose.model(
    'BillingRolloutEmergencyStop',
    BillingRolloutEmergencyStopRecordSchema,
  )
