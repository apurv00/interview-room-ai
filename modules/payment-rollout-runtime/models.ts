import mongoose, {
  Document,
  Model,
  Query,
  Schema,
} from 'mongoose'
import type { BillingRolloutRequestedState } from '@/modules/payment-rollout-control'
import {
  BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
  BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION,
} from './contracts'

export interface IBillingRolloutSubjectManifest extends Document {
  schemaVersion: typeof BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION
  manifestHash: string
  commandId: string
  correlationId: string
  subjectHashes: string[]
  subjectCount: number
  expiresAt: Date
  reason: string
  confirmation: string
  stagedByUserId: mongoose.Types.ObjectId
  stagedAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface IBillingRolloutRuntimeProjection extends Document {
  schemaVersion: typeof BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION
  key: 'singleton'
  configRevision: number
  configHash: string
  deploymentId: string
  commitSha: string
  state: BillingRolloutRequestedState
  allowlistSubjectHashes: string[]
  createdAt: Date
  updatedAt: Date
}

const digest = () => ({
  type: String,
  required: true,
  match: /^[a-f0-9]{64}$/,
})

const BillingRolloutSubjectManifestSchema =
  new Schema<IBillingRolloutSubjectManifest>(
    {
      schemaVersion: {
        type: String,
        enum: [BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION],
        required: true,
        immutable: true,
      },
      manifestHash: { ...digest(), immutable: true },
      commandId: {
        type: String,
        required: true,
        minlength: 3,
        maxlength: 200,
        immutable: true,
      },
      correlationId: {
        type: String,
        required: true,
        minlength: 3,
        maxlength: 200,
        immutable: true,
      },
      subjectHashes: {
        type: [String],
        required: true,
        immutable: true,
        validate: {
          validator: (values: string[]) =>
            values.length >= 1 &&
            values.length <= 500 &&
            values.every(
              (value, index) =>
                /^[a-f0-9]{64}$/.test(value) &&
                (index === 0 || values[index - 1]! < value),
            ),
          message: 'Subject hashes must be sorted unique digests',
        },
      },
      subjectCount: {
        type: Number,
        required: true,
        min: 1,
        max: 500,
        immutable: true,
        validate: Number.isSafeInteger,
      },
      expiresAt: { type: Date, required: true, immutable: true },
      reason: {
        type: String,
        required: true,
        minlength: 20,
        maxlength: 2000,
        immutable: true,
      },
      confirmation: {
        type: String,
        required: true,
        minlength: 1,
        maxlength: 256,
        immutable: true,
      },
      stagedByUserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
      },
      stagedAt: { type: Date, required: true, immutable: true },
    },
    { timestamps: true, strict: 'throw' },
  )

BillingRolloutSubjectManifestSchema.index(
  { manifestHash: 1, expiresAt: 1 },
  { unique: true },
)
BillingRolloutSubjectManifestSchema.index(
  { commandId: 1 },
  { unique: true },
)
BillingRolloutSubjectManifestSchema.index({ expiresAt: 1 })

function rejectManifestMutation(
  this: Query<unknown, IBillingRolloutSubjectManifest>,
): never {
  throw new Error('Billing rollout subject manifests are append-only')
}

BillingRolloutSubjectManifestSchema.pre(
  'updateOne',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'findOneAndUpdate',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'replaceOne',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'deleteOne',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'findOneAndDelete',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'updateMany',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'deleteMany',
  rejectManifestMutation,
)
BillingRolloutSubjectManifestSchema.pre(
  'save',
  function rejectSavedManifestMutation() {
    if (!this.isNew) {
      throw new Error('Billing rollout subject manifests are append-only')
    }
  },
)

const BillingRolloutRuntimeProjectionSchema =
  new Schema<IBillingRolloutRuntimeProjection>(
    {
      schemaVersion: {
        type: String,
        enum: [BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION],
        required: true,
      },
      key: {
        type: String,
        enum: ['singleton'],
        required: true,
        default: 'singleton',
      },
      configRevision: {
        type: Number,
        required: true,
        min: 0,
        validate: Number.isSafeInteger,
      },
      configHash: digest(),
      deploymentId: {
        type: String,
        required: true,
        minlength: 3,
        maxlength: 200,
      },
      commitSha: {
        type: String,
        required: true,
        match: /^[a-f0-9]{7,64}$/,
      },
      state: { type: Schema.Types.Mixed, required: true },
      allowlistSubjectHashes: {
        type: [String],
        required: true,
        default: [],
        validate: {
          validator: (values: string[]) =>
            values.length <= 500 &&
            values.every(
              (value, index) =>
                /^[a-f0-9]{64}$/.test(value) &&
                (index === 0 || values[index - 1]! < value),
            ),
          message: 'Projection subject hashes must be sorted unique digests',
        },
      },
    },
    { timestamps: true, strict: 'throw' },
  )

BillingRolloutRuntimeProjectionSchema.index(
  { key: 1 },
  { unique: true },
)

export const BillingRolloutSubjectManifestModel:
Model<IBillingRolloutSubjectManifest> =
  mongoose.models.BillingRolloutSubjectManifest ||
  mongoose.model<IBillingRolloutSubjectManifest>(
    'BillingRolloutSubjectManifest',
    BillingRolloutSubjectManifestSchema,
  )

export const BillingRolloutRuntimeProjectionModel:
Model<IBillingRolloutRuntimeProjection> =
  mongoose.models.BillingRolloutRuntimeProjection ||
  mongoose.model<IBillingRolloutRuntimeProjection>(
    'BillingRolloutRuntimeProjection',
    BillingRolloutRuntimeProjectionSchema,
  )
