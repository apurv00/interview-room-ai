import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_MEDIA_KINDS = [
  'identity_photo',
  'camera_recording',
  'audio_recording',
] as const
export type HireMediaKind = (typeof HIRE_MEDIA_KINDS)[number]

export const HIRE_MEDIA_STATES = [
  'staging',
  'ready',
  'purge_claimed',
  'purge_failed',
  'purged',
] as const
export type HireMediaState = (typeof HIRE_MEDIA_STATES)[number]

export const HIRE_MEDIA_PURGE_REASONS = [
  'job_closed',
  'privacy_request',
  'replaced',
  'stale_staging',
] as const
export type HireMediaPurgeReason = (typeof HIRE_MEDIA_PURGE_REASONS)[number]

export interface IHireMediaAsset extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  kind: HireMediaKind
  state: HireMediaState
  active?: boolean
  objectKey: string
  contentType: string
  bytes: number
  sha256: string
  width?: number
  height?: number
  capturedAt: Date
  purgeEligibleAt?: Date
  purgeReason?: HireMediaPurgeReason
  purgeClaimedAt?: Date
  purgeFailureCode?: string
  purgedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireMediaAssetSchema = new Schema<IHireMediaAsset>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, ref: 'HireInterviewAttempt', required: true, immutable: true },
    kind: { type: String, enum: HIRE_MEDIA_KINDS, required: true, immutable: true },
    state: { type: String, enum: HIRE_MEDIA_STATES, required: true },
    active: { type: Boolean },
    objectKey: { type: String, required: true, immutable: true, maxlength: 1000 },
    contentType: { type: String, required: true, immutable: true, maxlength: 100 },
    bytes: { type: Number, required: true, immutable: true, min: 1 },
    sha256: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    width: { type: Number, immutable: true, min: 1, max: 10000 },
    height: { type: Number, immutable: true, min: 1, max: 10000 },
    capturedAt: { type: Date, required: true, immutable: true },
    purgeEligibleAt: { type: Date },
    purgeReason: { type: String, enum: HIRE_MEDIA_PURGE_REASONS },
    purgeClaimedAt: { type: Date },
    purgeFailureCode: { type: String, maxlength: 160 },
    purgedAt: { type: Date },
  },
  { timestamps: true }
)

HireMediaAssetSchema.index({ objectKey: 1 }, { unique: true })
HireMediaAssetSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, attemptId: 1, kind: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
)
HireMediaAssetSchema.index({ state: 1, purgeEligibleAt: 1 })
HireMediaAssetSchema.index({ workspaceId: 1, candidateId: 1, state: 1 })
HireMediaAssetSchema.index({ workspaceId: 1, jobId: 1, purgeEligibleAt: 1, state: 1 })

export const HireMediaAsset: Model<IHireMediaAsset> =
  mongoose.models.HireMediaAsset ||
  mongoose.model<IHireMediaAsset>('HireMediaAsset', HireMediaAssetSchema)
