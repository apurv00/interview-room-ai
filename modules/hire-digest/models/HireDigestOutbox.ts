import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_DIGEST_MAX_ATTEMPTS,
  HIRE_DIGEST_OUTBOX_STATUSES,
  HIRE_DIGEST_PERIOD_KEY,
  type HireDigestOutboxStatus,
  type HireDigestPayload,
} from '../types'

export interface IHireDigestOutbox extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  memberId: mongoose.Types.ObjectId
  /** Idempotency coordinate, fixed by the documented UTC-day policy. */
  periodKey: string
  /** Recipient PII is worker-only and never selected by member/audit DTOs. */
  recipientEmail: string
  recipientName: string
  /** Immutable aggregate-only snapshot for retriable, deterministic copy. */
  payload: HireDigestPayload
  status: HireDigestOutboxStatus
  sendAfter: Date
  attempts: number
  /** Exact worker authorization writes this counter before provider egress. */
  egressFenceVersion: number
  /**
   * Immutable workspace privacy/aggregate epoch captured with this snapshot.
   * A later candidate privacy or retention transaction advances the root
   * epoch, so this row can never pass exact egress authorization.
   */
  privacyAggregateFenceVersion: number
  claimToken?: string
  leaseExpiresAt?: Date
  providerMessageId?: string
  /** Opaque bounded diagnostic only; never a provider payload or recipient detail. */
  failureCode?: 'provider_unavailable' | 'max_attempts'
  sentAt?: Date
  cancelledAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireDigestPayloadSchema = new Schema<HireDigestPayload>(
  {
    workspaceName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    generatedAt: { type: Date, required: true, immutable: true },
    openJobs: { type: Number, required: true, min: 0, max: 1_000_000, immutable: true },
    awaitingDecision: { type: Number, required: true, min: 0, max: 1_000_000, immutable: true },
    pendingScorecards: { type: Number, required: true, min: 0, max: 1_000_000, immutable: true },
    terminalKitDeliveryFailures: { type: Number, required: true, min: 0, max: 1_000_000, immutable: true },
    validationAttentionInterviews: { type: Number, required: true, min: 0, max: 1_000_000, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const HireDigestOutboxSchema = new Schema<IHireDigestOutbox>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    memberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    periodKey: {
      type: String,
      required: true,
      immutable: true,
      match: HIRE_DIGEST_PERIOD_KEY,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      immutable: true,
      select: false,
    },
    recipientName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
      select: false,
    },
    payload: { type: HireDigestPayloadSchema, required: true, immutable: true, select: false },
    status: { type: String, enum: HIRE_DIGEST_OUTBOX_STATUSES, required: true, default: 'pending' },
    sendAfter: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0, min: 0, max: HIRE_DIGEST_MAX_ATTEMPTS },
    egressFenceVersion: { type: Number, required: true, default: 0, min: 0 },
    privacyAggregateFenceVersion: { type: Number, required: true, default: 0, min: 0, immutable: true },
    claimToken: { type: String, maxlength: 80, select: false },
    leaseExpiresAt: { type: Date },
    providerMessageId: { type: String, maxlength: 240, select: false },
    failureCode: { type: String, enum: ['provider_unavailable', 'max_attempts'] },
    sentAt: { type: Date },
    cancelledAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// The database—not cron cadence or a provider window—is the duplicate barrier.
HireDigestOutboxSchema.index({ workspaceId: 1, memberId: 1, periodKey: 1 }, { unique: true })
HireDigestOutboxSchema.index({ workspaceId: 1, status: 1, sendAfter: 1, leaseExpiresAt: 1, _id: 1 })
HireDigestOutboxSchema.index({ workspaceId: 1, memberId: 1, status: 1 })

export const HireDigestOutbox: Model<IHireDigestOutbox> =
  mongoose.models.HireDigestOutbox ||
  mongoose.model<IHireDigestOutbox>('HireDigestOutbox', HireDigestOutboxSchema)
