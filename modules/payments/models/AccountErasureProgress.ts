import mongoose, { Document, Model, Schema } from 'mongoose'

export const ACCOUNT_ERASURE_PROGRESS_STATUSES =
  ['erasing', 'retry_pending', 'review', 'completed'] as const
export type AccountErasureProgressStatus =
  (typeof ACCOUNT_ERASURE_PROGRESS_STATUSES)[number]
export interface AccountErasureArtifact { key: string; deletedAt?: Date }
export interface AccountErasureMultipartUpload {
  key: string; uploadId: string; abortedAt?: Date
}
export interface IAccountErasureProgress extends Document {
  deletionRequestId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  status: AccountErasureProgressStatus
  r2Artifacts: AccountErasureArtifact[]
  multipartUploads: AccountErasureMultipartUpload[]
  storageSweepVerifiedAt?: Date
  redisManifestVersion?: number
  redisSessionIds: string[]
  redisAggregateKeys: string[]
  redisManifestHash?: string
  redisSessionCount?: number
  redisAggregateKeyCount?: number
  externalWriteDrainUntil?: Date
  databaseErasedAt?: Date
  redisDrainUntil?: Date
  redisSweepVerifiedAt?: Date
  redisCertificationVersion?: number
  attempts: number
  leaseToken?: string
  leaseExpiresAt?: Date
  nextAttemptAt?: Date
  lastErrorCode?: string
  startedAt: Date
  completedAt?: Date
  databaseCounts?: Record<string, number>
  createdAt: Date
  updatedAt: Date
}
const ArtifactSchema = new Schema<AccountErasureArtifact>(
  {
    key: {
      type: String, required: true, trim: true,
      minlength: 1, maxlength: 1024, immutable: true,
    },
    deletedAt: { type: Date },
  },
  { _id: false },
)
const MultipartUploadSchema =
  new Schema<AccountErasureMultipartUpload>(
    {
      key: {
        type: String, required: true, trim: true,
        minlength: 1, maxlength: 1024, immutable: true,
      },
      uploadId: {
        type: String, required: true, trim: true,
        minlength: 1, maxlength: 1024, immutable: true,
      },
      abortedAt: { type: Date },
    },
    { _id: false },
  )

const AccountErasureProgressSchema =
  new Schema<IAccountErasureProgress>(
    {
      deletionRequestId: {
        type: Schema.Types.ObjectId, ref: 'AccountDeletionRequest',
        required: true, immutable: true,
      },
      userId: {
        type: Schema.Types.ObjectId, ref: 'User',
        required: true, immutable: true,
      },
      status: {
        type: String, enum: ACCOUNT_ERASURE_PROGRESS_STATUSES, required: true,
      },
      r2Artifacts: {
        type: [ArtifactSchema], required: true, default: [],
      },
      multipartUploads: {
        type: [MultipartUploadSchema], required: true, default: [],
      },
      storageSweepVerifiedAt: { type: Date },
      redisManifestVersion: { type: Number, min: 1, max: 1 },
      redisSessionIds: {
        type: [{ type: String, match: /^[0-9a-f]{24}$/i }],
        default: [],
      },
      redisAggregateKeys: {
        type: [{ type: String, minlength: 1, maxlength: 256 }],
        default: [],
      },
      redisManifestHash: { type: String, match: /^[0-9a-f]{64}$/ },
      redisSessionCount: { type: Number, min: 0 },
      redisAggregateKeyCount: { type: Number, min: 0 },
      externalWriteDrainUntil: { type: Date },
      databaseErasedAt: { type: Date },
      redisDrainUntil: { type: Date },
      redisSweepVerifiedAt: { type: Date },
      redisCertificationVersion: { type: Number, min: 1, max: 1 },
      attempts: { type: Number, required: true, default: 0, min: 0 },
      leaseToken: { type: String, trim: true, maxlength: 128 },
      leaseExpiresAt: { type: Date },
      nextAttemptAt: { type: Date },
      lastErrorCode: { type: String, trim: true, maxlength: 100 },
      startedAt: { type: Date, required: true, immutable: true },
      completedAt: { type: Date },
      databaseCounts: { type: Schema.Types.Mixed },
    },
    { timestamps: true },
  )
AccountErasureProgressSchema.pre('validate', function validateState() {
  const leased = Boolean(this.leaseToken && this.leaseExpiresAt)
  if (this.status === 'erasing' && !leased)
    this.invalidate('leaseToken', 'Active erasure requires a lease')
  if (this.status !== 'erasing' && leased)
    this.invalidate('leaseToken', 'Inactive erasure cannot retain a lease')
  if (this.status === 'completed') {
    if (!this.completedAt)
      this.invalidate('completedAt', 'Completed erasure requires completedAt')
    if (this.r2Artifacts.some((artifact) => !artifact.deletedAt))
      this.invalidate('r2Artifacts', 'Every object must be deleted first')
    if (this.multipartUploads.some((upload) => !upload.abortedAt))
      this.invalidate('multipartUploads', 'Every multipart upload must be aborted first')
    if (!this.storageSweepVerifiedAt) {
      this.invalidate(
        'storageSweepVerifiedAt',
        'Completed erasure requires a verified empty storage sweep',
      )
    }
    if (!this.databaseErasedAt)
      this.invalidate('databaseErasedAt', 'Completed erasure requires database erasure')
    if (
      !this.redisDrainUntil ||
      !this.redisSweepVerifiedAt ||
      this.redisSweepVerifiedAt < this.redisDrainUntil
    ) {
      this.invalidate('redisSweepVerifiedAt', 'Completed erasure requires final Redis certification')
    }
    if (
      this.redisManifestVersion !== 1 ||
      this.redisCertificationVersion !== 1
    ) {
      this.invalidate('redisManifestVersion', 'Completed erasure requires Redis v1 certificates')
    }
    if (this.redisSessionIds.length || this.redisAggregateKeys.length)
      this.invalidate('redisSessionIds', 'Completed erasure must clear Redis manifests')
  }
})
AccountErasureProgressSchema.index({ deletionRequestId: 1 }, { unique: true })
AccountErasureProgressSchema.index(
  { status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 },
)
export const AccountErasureProgress: Model<IAccountErasureProgress> =
  mongoose.models.AccountErasureProgress ||
  mongoose.model<IAccountErasureProgress>(
    'AccountErasureProgress',
    AccountErasureProgressSchema,
  )
