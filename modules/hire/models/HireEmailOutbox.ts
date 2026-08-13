import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_EMAIL_OUTBOX_KINDS = [
  'job_close_rejection',
] as const
export type HireEmailOutboxKind = (typeof HIRE_EMAIL_OUTBOX_KINDS)[number]

export const HIRE_EMAIL_OUTBOX_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const
export type HireEmailOutboxStatus = (typeof HIRE_EMAIL_OUTBOX_STATUSES)[number]

/** Durable, transactionally-created email work. A job is not considered
 * closed unless every required rejection has a corresponding outbox row. */
export interface IHireEmailOutbox extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  kind: HireEmailOutboxKind
  operationId: string
  recipientEmail: string
  recipientName: string
  payload: {
    jobTitle: string
    workspaceName: string
    decisionNote: string
    actorName: string
  }
  status: HireEmailOutboxStatus
  sendAfter: Date
  attempts: number
  claimToken?: string
  leaseExpiresAt?: Date
  lastError?: string
  providerMessageId?: string
  sentAt?: Date
  manualRetryCount: number
  lastManualRetryAt?: Date
  lastManualRetryByMemberId?: mongoose.Types.ObjectId
  lastManualRetryByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireEmailOutboxSchema = new Schema<IHireEmailOutbox>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    kind: { type: String, enum: HIRE_EMAIL_OUTBOX_KINDS, required: true, immutable: true },
    operationId: {
      type: String,
      required: true,
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      immutable: true,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      immutable: true,
    },
    recipientName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    payload: {
      jobTitle: { type: String, required: true, maxlength: 200 },
      workspaceName: { type: String, required: true, maxlength: 120 },
      decisionNote: { type: String, required: true, maxlength: 4000 },
      actorName: { type: String, required: true, maxlength: 120 },
    },
    status: { type: String, enum: HIRE_EMAIL_OUTBOX_STATUSES, default: 'pending' },
    sendAfter: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    claimToken: { type: String, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    providerMessageId: { type: String, maxlength: 240 },
    sentAt: { type: Date },
    manualRetryCount: { type: Number, default: 0, min: 0 },
    lastManualRetryAt: { type: Date },
    lastManualRetryByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
    },
    lastManualRetryByName: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true },
)

HireEmailOutboxSchema.index(
  { workspaceId: 1, operationId: 1, applicationId: 1, kind: 1 },
  { unique: true },
)
HireEmailOutboxSchema.index({ workspaceId: 1, status: 1, sendAfter: 1, _id: 1 })
HireEmailOutboxSchema.index({ workspaceId: 1, jobId: 1, kind: 1, status: 1, createdAt: 1 })

export const HireEmailOutbox: Model<IHireEmailOutbox> =
  mongoose.models.HireEmailOutbox ||
  mongoose.model<IHireEmailOutbox>('HireEmailOutbox', HireEmailOutboxSchema)
