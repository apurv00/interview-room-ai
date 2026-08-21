import mongoose, { Document, Model, Schema } from 'mongoose'
import type {
  HireEngineConfig,
  HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'

export type HireRuntimeBindingStatus = 'provisioned' | 'active' | 'completed' | 'revoked'
export type HireRuntimeCameraMediaStatus =
  | 'pending'
  | 'published'
  | 'unavailable'
export type HireRuntimeScreenMediaStatus =
  | 'pending'
  | 'published'
  | 'unavailable'
export type HireRuntimeMediaUnavailableReason =
  | 'capture_failed'
  | 'durable_queue_failed'
  | 'upload_rejected'
  | 'retry_exhausted'
  | 'upload_expired'
export type HireRuntimeReplayMediaKind = 'camera' | 'screen'
export type HireRuntimeAuthTicketState = 'issued' | 'consumed'

export interface IHireRuntimeBinding extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  principalId: mongoose.Types.ObjectId
  handoffNonce: string
  authTicketGeneration?: number
  authTicketHandoffNonce?: string
  authTicketState?: HireRuntimeAuthTicketState
  authTicketDigest?: string
  authTicketExpiresAt?: Date
  authTicketIssuedAt?: Date
  authTicketConsumedAt?: Date
  config: HireEngineConfig
  consentVersion: string
  consentAt: Date
  inviteExpiresAt: Date
  status: HireRuntimeBindingStatus
  runtimeSessionId?: mongoose.Types.ObjectId
  attemptCount: number
  sessionLeaseToken?: string
  sessionLeaseExpiresAt?: Date
  principalLeaseToken?: string
  principalLeaseExpiresAt?: Date
  runtimeWriteDrainUntil?: Date
  /**
   * Per-kind, pre-side-effect write reservations. A reservation is created
   * after request validation but before R2/session mutation, then removed only
   * after the durable capability/finalization checkpoint succeeds. Expiry is
   * the bounded crash-recovery drain for a worker that dies mid-request.
   */
  mediaWriteReservations?: Array<{
    reservationId: string
    kind: HireRuntimeReplayMediaKind
    expiresAt: Date
  }>
  issuedObjectCapabilities?: Array<{
    key: string
    /** Temporary authority for a digest-only runtime landmark v2 key. */
    objectKeyNonce?: string
    runtimeSessionId: mongoose.Types.ObjectId
    expiresAt: Date
  }>
  issuedMultipartCapabilities?: Array<{
    key: string
    runtimeSessionId: mongoose.Types.ObjectId
    uploadId: string
    expiresAt: Date
  }>
  revokedAt?: Date
  revokeReason?: string
  purgePersonalData?: boolean
  personalDataPurgedAt?: Date
  /** Durable round-retention fence; raw analysis capture may never reopen it. */
  multimodalObservationRetentionPurgedAt?: Date
  pendingMediaManifest?: HireEngineResultIngestion['media']
  /**
   * Immutable marker stamped only by snapshot-aware binding creation. It lets
   * the publisher distinguish a safe pre-send defer from a legacy attempt
   * whose acknowledgement may have been lost before snapshots existed.
   */
  resultPayloadSnapshotProtocolVersion?: 1
  /**
   * Exact serialized result bridge payload. Before acknowledgement it is the
   * in-flight event; while replay media is still pending it is retained as the
   * last acknowledged immutable result core for the next revision. This keeps
   * every retry and follow-up independent of a mutable completed session
   * without storing two near-body-limit JSON copies on one Mongo document.
   */
  pendingResultPayloadJson?: string
  /**
   * Present only on bindings created after the durable candidate-media
   * completion contract shipped. Missing is an intentional legacy marker:
   * older attempts keep their historical completion behaviour instead of
   * acquiring a new collection duty after the fact.
   */
  mediaCompletionContractVersion?: 1
  mediaCompletionDeadlineAt?: Date
  publishedRevision?: number
  publishedDigest?: string
  publishedAt?: Date
  /**
   * Kept separate from `publishedRevision`: result revision 1 may be safely
   * acknowledged before the browser finishes its large camera upload. A
   * missing value is intentionally treated as legacy/unknown after revision
   * 1, so an old binding never tries to re-hash a source object that a prior
   * version already deleted.
   */
  cameraMediaStatus?: HireRuntimeCameraMediaStatus
  cameraMediaPublishedAt?: Date
  cameraMediaUnavailableAt?: Date
  cameraMediaUnavailableReason?: HireRuntimeMediaUnavailableReason
  cameraMediaUnavailableReportedAt?: Date
  cameraMediaTerminalClaimToken?: string
  cameraMediaTerminalClaimExpiresAt?: Date
  cameraMediaTerminalClaimArtifactVersion?: number
  /** Present only for screen-share-consented attempts. Missing legacy values
   * are terminal so an old attempt never acquires a new collection duty. */
  screenMediaStatus?: HireRuntimeScreenMediaStatus
  screenMediaPublishedAt?: Date
  screenMediaUnavailableAt?: Date
  screenMediaUnavailableReason?: HireRuntimeMediaUnavailableReason
  screenMediaUnavailableReportedAt?: Date
  screenMediaTerminalClaimToken?: string
  screenMediaTerminalClaimExpiresAt?: Date
  screenMediaTerminalClaimArtifactVersion?: number
  publishCheckedAt?: Date
  publishFailureCount?: number
  publishRetryAt?: Date
  publishFailureCode?: string
  feedbackRecoveryLeaseToken?: string
  feedbackRecoveryLeaseExpiresAt?: Date
  feedbackRecoveryAttemptCount?: number
  feedbackRecoveryRetryAt?: Date
  feedbackRecoveryCheckedAt?: Date
  feedbackRecoveryFailureCode?: string
  createdAt: Date
  updatedAt: Date
}

const HireRuntimeBindingSchema = new Schema<IHireRuntimeBinding>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    principalId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
      unique: true,
    },
    handoffNonce: {
      type: String,
      required: true,
      immutable: true,
      unique: true,
      match: /^[a-f0-9]{64}$/,
    },
    authTicketGeneration: { type: Number, min: 1 },
    authTicketHandoffNonce: { type: String, match: /^[a-f0-9]{64}$/ },
    authTicketState: { type: String, enum: ['issued', 'consumed'] },
    authTicketDigest: { type: String, match: /^[a-f0-9]{64}$/ },
    authTicketExpiresAt: { type: Date },
    authTicketIssuedAt: { type: Date },
    authTicketConsumedAt: { type: Date },
    config: {
      role: { type: String, required: true, maxlength: 100 },
      interviewType: { type: String, required: true, maxlength: 50 },
      experience: { type: String, enum: ['0-2', '3-6', '7+'], required: true },
      duration: { type: Number, min: 5, max: 30, required: true },
      jobDescription: { type: String, required: true, maxlength: 50_000 },
      targetCompany: { type: String, maxlength: 200 },
    },
    consentVersion: { type: String, required: true, maxlength: 80, immutable: true },
    consentAt: { type: Date, required: true, immutable: true },
    inviteExpiresAt: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: ['provisioned', 'active', 'completed', 'revoked'],
      required: true,
      default: 'provisioned',
    },
    runtimeSessionId: {
      type: Schema.Types.ObjectId,
      ref: 'InterviewSession',
      unique: true,
      sparse: true,
    },
    attemptCount: { type: Number, required: true, default: 0, min: 0, max: 10 },
    sessionLeaseToken: { type: String, maxlength: 64 },
    sessionLeaseExpiresAt: { type: Date },
    principalLeaseToken: { type: String, maxlength: 64 },
    principalLeaseExpiresAt: { type: Date },
    runtimeWriteDrainUntil: { type: Date },
    mediaWriteReservations: {
      type: [
        new Schema(
          {
            reservationId: {
              type: String,
              required: true,
              maxlength: 64,
            },
            kind: {
              type: String,
              enum: ['camera', 'screen'],
              required: true,
            },
            expiresAt: { type: Date, required: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: undefined,
    },
    issuedObjectCapabilities: {
      type: [
        new Schema(
          {
            key: {
              type: String,
              required: true,
              maxlength: 1_024,
              validate: {
                validator(this: { objectKeyNonce?: string }, key: string) {
                  const v2 = /^landmarks\/v2\/[a-f0-9]{64}$/.test(key)
                  if (key.startsWith('landmarks/v2/') && !v2) return false
                  return v2
                    ? /^[a-f0-9]{64}$/.test(this.objectKeyNonce ?? '')
                    : this.objectKeyNonce === undefined
                },
                message: 'Runtime object capability key and nonce do not match',
              },
            },
            objectKeyNonce: {
              type: String,
              match: /^[a-f0-9]{64}$/,
              immutable: true,
            },
            runtimeSessionId: {
              type: Schema.Types.ObjectId,
              ref: 'InterviewSession',
              required: true,
            },
            expiresAt: { type: Date, required: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: undefined,
    },
    issuedMultipartCapabilities: {
      type: [
        new Schema(
          {
            key: { type: String, required: true, maxlength: 1_024 },
            runtimeSessionId: {
              type: Schema.Types.ObjectId,
              ref: 'InterviewSession',
              required: true,
            },
            uploadId: { type: String, required: true, maxlength: 1_024 },
            expiresAt: { type: Date, required: true },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: undefined,
    },
    revokedAt: { type: Date },
    revokeReason: { type: String, maxlength: 500 },
    purgePersonalData: { type: Boolean, default: false },
    personalDataPurgedAt: { type: Date },
    multimodalObservationRetentionPurgedAt: { type: Date },
    pendingMediaManifest: {
      type: [
        new Schema(
          {
            kind: {
              type: String,
              enum: ['recording', 'screen', 'audio', 'transcript', 'landmarks'],
              required: true,
            },
            sourceKey: { type: String, required: true, maxlength: 1_024 },
            contentType: { type: String, required: true, maxlength: 120 },
            sizeBytes: { type: Number, required: true, min: 0 },
            sha256: {
              type: String,
              required: true,
              match: /^[a-f0-9]{64}$/,
            },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: undefined,
    },
    resultPayloadSnapshotProtocolVersion: {
      type: Number,
      enum: [1],
      immutable: true,
    },
    pendingResultPayloadJson: { type: String, maxlength: 12 * 1024 * 1024 },
    mediaCompletionContractVersion: {
      type: Number,
      enum: [1],
      immutable: true,
    },
    mediaCompletionDeadlineAt: { type: Date },
    publishedRevision: { type: Number, min: 1, max: 10 },
    publishedDigest: { type: String, match: /^[a-f0-9]{64}$/ },
    publishedAt: { type: Date },
    cameraMediaStatus: {
      type: String,
      enum: ['pending', 'published', 'unavailable'],
    },
    cameraMediaPublishedAt: { type: Date },
    cameraMediaUnavailableAt: { type: Date },
    cameraMediaUnavailableReason: {
      type: String,
      enum: [
        'capture_failed',
        'durable_queue_failed',
        'upload_rejected',
        'retry_exhausted',
        'upload_expired',
      ],
    },
    cameraMediaUnavailableReportedAt: { type: Date },
    cameraMediaTerminalClaimToken: { type: String, maxlength: 64 },
    cameraMediaTerminalClaimExpiresAt: { type: Date },
    cameraMediaTerminalClaimArtifactVersion: { type: Number, min: 0 },
    screenMediaStatus: {
      type: String,
      enum: ['pending', 'published', 'unavailable'],
    },
    screenMediaPublishedAt: { type: Date },
    screenMediaUnavailableAt: { type: Date },
    screenMediaUnavailableReason: {
      type: String,
      enum: [
        'capture_failed',
        'durable_queue_failed',
        'upload_rejected',
        'retry_exhausted',
        'upload_expired',
      ],
    },
    screenMediaUnavailableReportedAt: { type: Date },
    screenMediaTerminalClaimToken: { type: String, maxlength: 64 },
    screenMediaTerminalClaimExpiresAt: { type: Date },
    screenMediaTerminalClaimArtifactVersion: { type: Number, min: 0 },
    publishCheckedAt: { type: Date },
    publishFailureCount: { type: Number, min: 0, default: 0 },
    publishRetryAt: { type: Date },
    publishFailureCode: { type: String, maxlength: 120 },
    feedbackRecoveryLeaseToken: { type: String, maxlength: 64 },
    feedbackRecoveryLeaseExpiresAt: { type: Date },
    feedbackRecoveryAttemptCount: { type: Number, min: 0, default: 0 },
    feedbackRecoveryRetryAt: { type: Date },
    feedbackRecoveryCheckedAt: { type: Date },
    feedbackRecoveryFailureCode: { type: String, maxlength: 120 },
  },
  { timestamps: true, strict: 'throw' },
)

HireRuntimeBindingSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1 },
  { unique: true },
)
HireRuntimeBindingSchema.index({
  workspaceId: 1,
  status: 1,
  purgePersonalData: 1,
  publishedRevision: 1,
  cameraMediaStatus: 1,
  screenMediaStatus: 1,
  cameraMediaUnavailableReportedAt: 1,
  screenMediaUnavailableReportedAt: 1,
  publishRetryAt: 1,
  publishCheckedAt: 1,
  updatedAt: 1,
})
HireRuntimeBindingSchema.index({
  workspaceId: 1,
  purgePersonalData: 1,
  feedbackRecoveryRetryAt: 1,
  feedbackRecoveryCheckedAt: 1,
})

export const HireRuntimeBinding: Model<IHireRuntimeBinding> =
  mongoose.models.HireRuntimeBinding ||
  mongoose.model<IHireRuntimeBinding>('HireRuntimeBinding', HireRuntimeBindingSchema)
