import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_JOB_STATUSES = ['open', 'on_hold', 'closed'] as const
export type HireJobStatus = (typeof HIRE_JOB_STATUSES)[number]

export interface IHireJobEvent {
  type: 'status_change' | 'department_change'
  /** Required for a status transition; omitted for a department correction. */
  from?: HireJobStatus
  to?: HireJobStatus
  /** Required only for a department correction event. */
  fromDepartmentId?: mongoose.Types.ObjectId
  toDepartmentId?: mongoose.Types.ObjectId
  actorMemberId?: mongoose.Types.ObjectId
  actorUserId?: mongoose.Types.ObjectId
  actorName: string
  note?: string
  operationId?: string
  at: Date
}

/**
 * Optional, job-owned defaults for the Phase-2 screening gate. These are
 * deliberately separate from the structured JD requirements: they describe
 * only deterministic knockout checks, never a candidate identity or a B2C
 * account.
 */
export interface IHireScreeningSettings {
  location?: string
  experienceFloorYears?: number
}

/**
 * A job requisition. The JD text is the grounding for AI interview rounds
 * (question generation + jd_match_score) — required at creation, immutable in
 * spirit after rounds are sent (enforced in pipelineService, not the schema,
 * so a typo fix before the first send stays possible).
 */
export interface IHireJob extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  /**
   * Required workspace-scoped hiring classification. Department ownership is
   * carried by the job only: applications, rounds, and evidence derive it
   * through this immutable tenancy coordinate instead of duplicating it.
   */
  departmentId: mongoose.Types.ObjectId
  title: string
  jdText: string
  /** Immutable scoring-contract revision used for new scoring/rounds. */
  activeRequirementVersionId?: mongoose.Types.ObjectId
  activeRequirementVersion?: number
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
  /** Optional defaults copied into a confirmed screening-gate snapshot. */
  screeningSettings?: IHireScreeningSettings
  closeNote?: string
  closedAt?: Date
  closedBy?: mongoose.Types.ObjectId
  closedByMemberId?: mongoose.Types.ObjectId
  closedByName?: string
  events: IHireJobEvent[]
  createdBy?: mongoose.Types.ObjectId
  createdByMemberId?: mongoose.Types.ObjectId
  createdByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireJobEventSchema = new Schema<IHireJobEvent>(
  {
    type: { type: String, enum: ['status_change', 'department_change'], required: true },
    from: {
      type: String,
      enum: HIRE_JOB_STATUSES,
      required: function requiredStatusFrom(this: IHireJobEvent) {
        return this.type === 'status_change'
      },
    },
    to: {
      type: String,
      enum: HIRE_JOB_STATUSES,
      required: function requiredStatusTo(this: IHireJobEvent) {
        return this.type === 'status_change'
      },
    },
    fromDepartmentId: {
      type: Schema.Types.ObjectId,
      ref: 'HireDepartment',
      required: function requiredDepartmentFrom(this: IHireJobEvent) {
        return this.type === 'department_change'
      },
    },
    toDepartmentId: {
      type: Schema.Types.ObjectId,
      ref: 'HireDepartment',
      required: function requiredDepartmentTo(this: IHireJobEvent) {
        return this.type === 'department_change'
      },
    },
    actorMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, required: true, maxlength: 120 },
    note: { type: String, maxlength: 4000 },
    operationId: { type: String, maxlength: 80 },
    at: { type: Date, required: true },
  },
  { _id: false },
)

const HireScreeningSettingsSchema = new Schema<IHireScreeningSettings>(
  {
    location: { type: String, trim: true, maxlength: 160 },
    experienceFloorYears: { type: Number, min: 0, max: 50 },
  },
  { _id: false },
)

const HireJobSchema = new Schema<IHireJob>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: 'HireDepartment',
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    jdText: { type: String, required: true, maxlength: 50000 },
    activeRequirementVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJobRequirementVersion',
    },
    activeRequirementVersion: { type: Number, min: 1 },
    status: { type: String, enum: HIRE_JOB_STATUSES, default: 'open' },
    // Conflict-inducing counter for the in-transaction intake claim: intake
    // $incs it with `status: {$ne:'closed'}` in the filter so a concurrent
    // job-close serializes against intake writes instead of racing them
    // (snapshot reads alone permit write skew). The value itself is unused.
    intakeWriteVersion: { type: Number, default: 0 },
    applyTokenHash: { type: String, maxlength: 64 },
    applyPageEnabled: { type: Boolean, default: false },
    screeningSettings: { type: HireScreeningSettingsSchema, default: undefined },
    closeNote: { type: String, maxlength: 4000 },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    closedByName: { type: String, maxlength: 120 },
    events: { type: [HireJobEventSchema], default: [] },
    // Legacy B2C actor pointer. New Hire work is attributed to the member
    // id/name snapshot and does not require a User row.
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    createdByName: { type: String, maxlength: 120 },
  },
  { timestamps: true }
)

HireJobSchema.index({ workspaceId: 1, status: 1, createdAt: -1 })
// Department is mandatory job metadata, so the common department health and
// reporting filters stay workspace-leading and never need a collection scan.
HireJobSchema.index({ workspaceId: 1, departmentId: 1, status: 1, createdAt: -1 })
HireJobSchema.index({ workspaceId: 1, 'events.operationId': 1 })
// Public apply-page lookup: the ONLY query that finds a job without a
// workspace id, and it needs the hash to be selective. Sparse — most jobs
// never enable the page.
HireJobSchema.index({ applyTokenHash: 1 }, { sparse: true })

export const HireJob: Model<IHireJob> =
  mongoose.models.HireJob || mongoose.model<IHireJob>('HireJob', HireJobSchema)
