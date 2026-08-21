import { randomUUID } from 'node:crypto'
import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_MEDIA_INGESTION_LEASE_MS = 60 * 60 * 1000

export interface HireMediaIngestionLease {
  ingestionLeaseId: string
  ingestionLeaseExpiresAt: Date
}

/**
 * Grants one writer exclusive authority to finish a staged media upload.
 * Lifecycle workers must not purge a staging row while this lease is active,
 * and writers must fence their final state transition with the returned ID.
 */
export function createHireMediaIngestionLease(
  now: Date = new Date(),
): HireMediaIngestionLease {
  return {
    ingestionLeaseId: randomUUID(),
    ingestionLeaseExpiresAt: new Date(now.getTime() + HIRE_MEDIA_INGESTION_LEASE_MS),
  }
}

export const HIRE_MEDIA_KINDS = [
  'identity_photo',
  'camera_recording',
  'screen_recording',
  'audio_recording',
  // Private input to Hire's recorded-interview analysis. It is lifecycle
  // managed like other candidate media but is never download-capable.
  'facial_landmarks',
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
  ingestionLeaseId?: string
  ingestionLeaseExpiresAt?: Date
  objectKey: string
  /** Required for v2 opaque keys; absent only on legacy coordinate-path keys. */
  objectKeyNonce?: string
  contentType: string
  bytes: number
  sha256: string
  width?: number
  height?: number
  capturedAt: Date
  purgeEligibleAt?: Date
  purgeReason?: HireMediaPurgeReason
  purgeClaimId?: string
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
    ingestionLeaseId: { type: String, maxlength: 80 },
    ingestionLeaseExpiresAt: { type: Date },
    objectKey: { type: String, required: true, immutable: true, maxlength: 1000 },
    objectKeyNonce: {
      type: String,
      immutable: true,
      select: false,
      required: function requiredV2ObjectKeyNonce(this: IHireMediaAsset) {
        return this.objectKey.startsWith('hire-media/v2/')
      },
      minlength: 64,
      maxlength: 64,
      match: /^[a-f0-9]{64}$/,
    },
    contentType: { type: String, required: true, immutable: true, maxlength: 100 },
    bytes: { type: Number, required: true, immutable: true, min: 1 },
    sha256: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    width: { type: Number, immutable: true, min: 1, max: 10000 },
    height: { type: Number, immutable: true, min: 1, max: 10000 },
    capturedAt: { type: Date, required: true, immutable: true },
    purgeEligibleAt: { type: Date },
    purgeReason: { type: String, enum: HIRE_MEDIA_PURGE_REASONS },
    purgeClaimId: { type: String, maxlength: 80 },
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
