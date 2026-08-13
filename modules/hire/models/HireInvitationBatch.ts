import mongoose, { Document, Model, Schema } from 'mongoose'

/** A worker is intentionally not part of this model-only Phase-2 slice. */
export const HIRE_INVITATION_BATCH_STATUSES = [
  'planned',
  'scheduled',
  'dispatching',
  'completed',
  'cancelled',
  'failed',
] as const
export type HireInvitationBatchStatus = (typeof HIRE_INVITATION_BATCH_STATUSES)[number]

/**
 * One confirmed group of invitation candidates. A later worker can stagger
 * batches by `sendAfter` and `wave` without changing the immutable gate
 * selection that created it.
 */
export interface IHireInvitationBatch extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  screeningGateId: mongoose.Types.ObjectId
  wave: number
  sendAfter: Date
  status: HireInvitationBatchStatus
  plannedCount: number
  sentCount: number
  failedCount: number
  claimToken?: string
  leaseExpiresAt?: Date
  lastError?: string
  completedAt?: Date
  cancelledAt?: Date
  cancelledByMemberId?: mongoose.Types.ObjectId
  cancelledByName?: string
  cancelNote?: string
  createdByMemberId: mongoose.Types.ObjectId
  createdByName: string
  createdAt: Date
  updatedAt: Date
}

const HireInvitationBatchSchema = new Schema<IHireInvitationBatch>(
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
    wave: { type: Number, required: true, min: 1, default: 1, immutable: true },
    sendAfter: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: HIRE_INVITATION_BATCH_STATUSES,
      required: true,
      default: 'planned',
    },
    plannedCount: { type: Number, required: true, min: 0, immutable: true },
    sentCount: { type: Number, required: true, min: 0, default: 0 },
    failedCount: { type: Number, required: true, min: 0, default: 0 },
    claimToken: { type: String, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    cancelledByName: { type: String, trim: true, maxlength: 120 },
    cancelNote: { type: String, trim: true, maxlength: 4000 },
    createdByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    createdByName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
  },
  { timestamps: true, strict: 'throw' },
)

// A gate has at most one durable batch for each planned wave.
HireInvitationBatchSchema.index(
  { workspaceId: 1, screeningGateId: 1, wave: 1 },
  { unique: true },
)
HireInvitationBatchSchema.index({ workspaceId: 1, status: 1, sendAfter: 1, _id: 1 })
HireInvitationBatchSchema.index({ workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 })

export const HireInvitationBatch: Model<IHireInvitationBatch> =
  mongoose.models.HireInvitationBatch ||
  mongoose.model<IHireInvitationBatch>('HireInvitationBatch', HireInvitationBatchSchema)
