import mongoose, { Document, Model, Schema } from 'mongoose'
import { HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES } from '@shared/contracts/hireMultimodalAnalysisBridge'

/**
 * Runtime delivery ledger for one private raw-landmark artifact. The artifact
 * itself stays in runtime R2 until the control plane checksum-copies and
 * acknowledges it; no raw frames are placed in Mongo.
 */
export interface IHireRuntimeMultimodalAnalysisOutbox extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  principalId: mongoose.Types.ObjectId
  runtimeSessionId: mongoose.Types.ObjectId
  attempt: number
  revision: 1
  consentVersion: string
  policyVersion: string
  eventId: string
  artifactDigest: string
  capturedAt: Date
  landmarkArtifact?: {
    sourceKey: string
    contentType: 'application/json'
    sizeBytes: number
    sha256: string
  }
  /** Exact serialized bridge payload, reserved once before the first send. */
  payloadSnapshotJson?: string
  status: 'pending' | 'published' | 'stale'
  publishLeaseToken?: string
  publishLeaseExpiresAt?: Date
  publishAttemptCount: number
  publishRetryAt?: Date
  publishedAt?: Date
  failureCode?: string
  createdAt: Date
  updatedAt: Date
}

const HireRuntimeMultimodalAnalysisArtifactSchema = new Schema(
  {
    sourceKey: { type: String, required: true, maxlength: 1_024, immutable: true },
    contentType: {
      type: String,
      enum: ['application/json'],
      required: true,
      immutable: true,
    },
    sizeBytes: { type: Number, required: true, min: 1, max: HIRE_MULTIMODAL_ANALYSIS_MAX_ARTIFACT_BYTES, immutable: true },
    sha256: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
  },
  { _id: false, strict: 'throw' },
)

const HireRuntimeMultimodalAnalysisOutboxSchema =
  new Schema<IHireRuntimeMultimodalAnalysisOutbox>(
    {
      workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      principalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      attempt: { type: Number, required: true, min: 1, max: 10, immutable: true },
      revision: { type: Number, required: true, enum: [1], immutable: true },
      consentVersion: { type: String, required: true, maxlength: 80, immutable: true },
      policyVersion: { type: String, required: true, maxlength: 80, immutable: true },
      eventId: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
      artifactDigest: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      capturedAt: { type: Date, required: true, immutable: true },
      landmarkArtifact: { type: HireRuntimeMultimodalAnalysisArtifactSchema },
      payloadSnapshotJson: { type: String, maxlength: 12 * 1024 * 1024 },
      status: { type: String, enum: ['pending', 'published', 'stale'], required: true },
      publishLeaseToken: { type: String, maxlength: 64 },
      publishLeaseExpiresAt: { type: Date },
      publishAttemptCount: { type: Number, required: true, default: 0, min: 0, max: 20 },
      publishRetryAt: { type: Date },
      publishedAt: { type: Date },
      failureCode: { type: String, maxlength: 120 },
    },
    { timestamps: true, strict: 'throw' },
  )

HireRuntimeMultimodalAnalysisOutboxSchema.index(
  {
    workspaceId: 1,
    roundId: 1,
    runtimeSessionId: 1,
    attempt: 1,
    revision: 1,
  },
  { unique: true },
)
HireRuntimeMultimodalAnalysisOutboxSchema.index(
  { workspaceId: 1, status: 1, publishRetryAt: 1, updatedAt: 1 },
)

export const HireRuntimeMultimodalAnalysisOutbox: Model<IHireRuntimeMultimodalAnalysisOutbox> =
  mongoose.models.HireRuntimeMultimodalAnalysisOutbox ||
  mongoose.model<IHireRuntimeMultimodalAnalysisOutbox>(
    'HireRuntimeMultimodalAnalysisOutbox',
    HireRuntimeMultimodalAnalysisOutboxSchema,
  )
