import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_SCREENING_SCORE_STATES,
  type HireScreeningScoreState,
} from './HireScreeningGate'

export const HIRE_INVITATION_BATCH_ITEM_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'skipped',
] as const
export type HireInvitationBatchItemStatus =
  (typeof HIRE_INVITATION_BATCH_ITEM_STATUSES)[number]

/** Mirrors the durable AI-delivery record without duplicating recipient PII. */
export const HIRE_INVITATION_BATCH_ITEM_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
] as const
export type HireInvitationBatchItemDeliveryStatus =
  (typeof HIRE_INVITATION_BATCH_ITEM_DELIVERY_STATUSES)[number]

export const HIRE_INVITATION_BATCH_ITEM_SELECTION_REASONS = [
  'top_n',
  'above_threshold',
  'manual_include',
  'waterfall',
] as const
export type HireInvitationBatchItemSelectionReason =
  (typeof HIRE_INVITATION_BATCH_ITEM_SELECTION_REASONS)[number]

/**
 * One selected application in a batch. It carries only Hire-owned IDs and a
 * non-PII selection snapshot; recipient email is intentionally resolved from
 * the candidate record by a future delivery worker at send time.
 */
export interface IHireInvitationBatchItem extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  screeningGateId: mongoose.Types.ObjectId
  invitationBatchId: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  candidateId?: mongoose.Types.ObjectId
  /**
   * Set only by the verified privacy-deletion and retention transactions after
   * direct recipient/application coordinates have been removed. The remaining
   * row is a non-identifying delivery aggregate, never a dispatchable item.
   */
  privacyRedactedAt?: Date
  rank?: number
  score: number | null
  scoreState: HireScreeningScoreState
  selectionReason: HireInvitationBatchItemSelectionReason
  sendAfter: Date
  status: HireInvitationBatchItemStatus
  attempts: number
  claimToken?: string
  leaseExpiresAt?: Date
  /** The only round this item may ever drive. Set after round recovery/send. */
  roundId?: mongoose.Types.ObjectId
  /** Durable encrypted-delivery row associated with `roundId`; no PII copied here. */
  inviteDeliveryId?: mongoose.Types.ObjectId
  deliveryStatus?: HireInvitationBatchItemDeliveryStatus
  sentAt?: Date
  providerMessageId?: string
  lastError?: string
  manualRetryCount: number
  lastManualRetryAt?: Date
  lastManualRetryByMemberId?: mongoose.Types.ObjectId
  lastManualRetryByName?: string
  skippedAt?: Date
  skipReason?: string
  cancelledAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireInvitationBatchItemSchema = new Schema<IHireInvitationBatchItem>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    screeningGateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireScreeningGate',
      required: true,
      immutable: true,
    },
    invitationBatchId: {
      type: Schema.Types.ObjectId,
      ref: 'HireInvitationBatch',
      required: true,
      immutable: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: function (this: unknown) {
        return !(this as { privacyRedactedAt?: unknown }).privacyRedactedAt
      },
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: function (this: unknown) {
        return !(this as { privacyRedactedAt?: unknown }).privacyRedactedAt
      },
      immutable: true,
    },
    privacyRedactedAt: { type: Date },
    rank: { type: Number, min: 1, immutable: true },
    score: { type: Number, min: 0, max: 100, default: null, immutable: true },
    scoreState: {
      type: String,
      enum: HIRE_SCREENING_SCORE_STATES,
      required: true,
      immutable: true,
    },
    selectionReason: {
      type: String,
      enum: HIRE_INVITATION_BATCH_ITEM_SELECTION_REASONS,
      required: true,
      immutable: true,
    },
    // Delivery failures are requeued against this same item with bounded
    // backoff. It must therefore stay mutable after the original schedule.
    sendAfter: { type: Date, required: true },
    status: {
      type: String,
      enum: HIRE_INVITATION_BATCH_ITEM_STATUSES,
      required: true,
      default: 'pending',
    },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    claimToken: { type: String, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound' },
    inviteDeliveryId: { type: Schema.Types.ObjectId, ref: 'HireAiInviteDelivery' },
    deliveryStatus: {
      type: String,
      enum: HIRE_INVITATION_BATCH_ITEM_DELIVERY_STATUSES,
    },
    sentAt: { type: Date },
    providerMessageId: { type: String, maxlength: 240 },
    lastError: { type: String, maxlength: 2000 },
    manualRetryCount: { type: Number, required: true, min: 0, default: 0 },
    lastManualRetryAt: { type: Date },
    lastManualRetryByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    lastManualRetryByName: { type: String, trim: true, maxlength: 120 },
    skippedAt: { type: Date },
    skipReason: { type: String, maxlength: 500 },
    cancelledAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// An application can be invited at most once in its workspace. Waterfall
// retries update this same durable item; a later batch must select someone
// else rather than silently mailing the same candidate twice.
HireInvitationBatchItemSchema.index(
  { workspaceId: 1, applicationId: 1 },
  {
    unique: true,
    // Privacy-redacted rows deliberately no longer carry applicationId. A
    // partial index avoids multiple missing-field entries colliding while
    // preserving the one-invitation-per-live-application invariant.
    partialFilterExpression: {
      applicationId: { $exists: true },
    },
  },
)
HireInvitationBatchItemSchema.index({ workspaceId: 1, status: 1, sendAfter: 1, _id: 1 })
HireInvitationBatchItemSchema.index({ workspaceId: 1, screeningGateId: 1, rank: 1, _id: 1 })
HireInvitationBatchItemSchema.index({ workspaceId: 1, roundId: 1 }, { sparse: true })

export const HireInvitationBatchItem: Model<IHireInvitationBatchItem> =
  mongoose.models.HireInvitationBatchItem ||
  mongoose.model<IHireInvitationBatchItem>(
    'HireInvitationBatchItem',
    HireInvitationBatchItemSchema,
  )
