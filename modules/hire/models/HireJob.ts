import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_JOB_STATUSES = ['open', 'on_hold', 'closed'] as const
export type HireJobStatus = (typeof HIRE_JOB_STATUSES)[number]

/**
 * A job requisition. The JD text is the grounding for AI interview rounds
 * (question generation + jd_match_score) — required at creation, immutable in
 * spirit after rounds are sent (enforced in pipelineService, not the schema,
 * so a typo fix before the first send stays possible).
 */
export interface IHireJob extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  title: string
  jdText: string
  status: HireJobStatus
  closeNote?: string
  closedAt?: Date
  closedBy?: mongoose.Types.ObjectId
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireJobSchema = new Schema<IHireJob>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    jdText: { type: String, required: true, maxlength: 50000 },
    status: { type: String, enum: HIRE_JOB_STATUSES, default: 'open' },
    closeNote: { type: String, maxlength: 4000 },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

HireJobSchema.index({ workspaceId: 1, status: 1, createdAt: -1 })

export const HireJob: Model<IHireJob> =
  mongoose.models.HireJob || mongoose.model<IHireJob>('HireJob', HireJobSchema)
