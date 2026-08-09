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
  /** Conflict-inducing counter for the in-transaction intake claim. */
  intakeWriteVersion?: number
  /**
   * sha256 of the public apply link's raw token. Like the round invite
   * token, the RAW value is shown to the recruiter once and never stored —
   * a database read must not yield a working public URL.
   */
  applyTokenHash?: string
  /** Recruiter switch; closing the job also stops applications. */
  applyPageEnabled?: boolean
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
    // Conflict-inducing counter for the in-transaction intake claim: intake
    // $incs it with `status: {$ne:'closed'}` in the filter so a concurrent
    // job-close serializes against intake writes instead of racing them
    // (snapshot reads alone permit write skew). The value itself is unused.
    intakeWriteVersion: { type: Number, default: 0 },
    applyTokenHash: { type: String, maxlength: 64 },
    applyPageEnabled: { type: Boolean, default: false },
    closeNote: { type: String, maxlength: 4000 },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

HireJobSchema.index({ workspaceId: 1, status: 1, createdAt: -1 })
// Public apply-page lookup: the ONLY query that finds a job without a
// workspace id, and it needs the hash to be selective. Sparse — most jobs
// never enable the page.
HireJobSchema.index({ applyTokenHash: 1 }, { sparse: true })

export const HireJob: Model<IHireJob> =
  mongoose.models.HireJob || mongoose.model<IHireJob>('HireJob', HireJobSchema)
