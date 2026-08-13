import mongoose, { Document, Model, Schema } from 'mongoose'

/** MongoDB document-size headroom still matters around the binary payload. */
export const HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024

export const HIRE_INTAKE_TASK_SOURCES = ['bulk_upload', 'apply_page'] as const
export type HireIntakeTaskSource = (typeof HIRE_INTAKE_TASK_SOURCES)[number]

/**
 * A durable intake worker must make a missing identity a recoverable state,
 * rather than failing and silently losing the uploaded document.
 */
export const HIRE_INTAKE_TASK_STATUSES = [
  'queued',
  'processing',
  'needs_identity',
  'completed',
  'failed',
  'cancelled',
] as const
export type HireIntakeTaskStatus = (typeof HIRE_INTAKE_TASK_STATUSES)[number]

/**
 * Durable, Hire-owned intake work for exactly one submitted resume.
 *
 * The queue event carries only this task id. The worker re-reads this record
 * with its workspace id, claims it with a lease, parses the payload, and then
 * writes the resulting HireCandidate/HireApplication in the same workspace.
 * No field in this model points at a B2C account or stores a raw apply token.
 */
export interface IHireIntakeTask extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  source: HireIntakeTaskSource

  originalFileName: string
  originalContentType: string
  originalFileSizeBytes: number
  /** Hidden by default so list/status queries never accidentally hydrate CVs. */
  payload?: Buffer

  /** Optional identity supplied by the recruiter or public applicant. */
  suppliedName?: string
  suppliedEmail?: string
  suppliedPhone?: string
  /** sha256 of the public apply capability. Never the raw capability. */
  applyTokenHash?: string

  /** Hire member snapshot for member-created work; absent for public apply. */
  actorMemberId?: mongoose.Types.ObjectId
  /** Immutable display snapshot, including the public-applicant system label. */
  actorName: string

  status: HireIntakeTaskStatus
  /** Increments once for each worker claim, including retry claims. */
  attempts: number
  claimToken?: string
  claimedAt?: Date
  leaseExpiresAt?: Date
  /** Earliest time a transient parser/model failure may be claimed again. */
  nextAttemptAt?: Date
  lastError?: string
  lastErrorAt?: Date
  queuedAt: Date
  statusChangedAt: Date
  needsIdentityAt?: Date
  completedAt?: Date
  failedAt?: Date
  cancelledAt?: Date

  /**
   * Set after a successful intake OR at enqueue when the supplied address
   * already resolves to this workspace's HireCandidate. The early association
   * lets a verified privacy deletion remove queued raw-resume work exactly.
   */
  candidateId?: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireIntakeTaskSchema = new Schema<IHireIntakeTask>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJob',
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: HIRE_INTAKE_TASK_SOURCES,
      required: true,
      immutable: true,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      immutable: true,
    },
    originalContentType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
      immutable: true,
    },
    originalFileSizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES,
      immutable: true,
      validate: {
        validator: function (this: unknown, bytes: number) {
          const payload = (this as { payload?: unknown }).payload
          return payload === undefined || (Buffer.isBuffer(payload) && payload.length === bytes)
        },
        message: 'originalFileSizeBytes must equal the payload byte length',
      },
    },
    payload: {
      type: Buffer,
      // The worker clears the binary after completion (or an erasure request).
      // `isNew` keeps creation safe without making a scoped $unset impossible.
      required: function (this: unknown) {
        return (this as { isNew?: unknown }).isNew === true
      },
      select: false,
      validate: {
        validator: (value: Buffer | undefined) =>
          value === undefined ||
          (Buffer.isBuffer(value) &&
            value.length > 0 &&
            value.length <= HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES),
        message: `payload must contain 1-${HIRE_INTAKE_TASK_MAX_PAYLOAD_BYTES} bytes`,
      },
    },
    // Worker/erasure paths may clear supplied PII after completion. Source,
    // file metadata, and capability hash stay immutable as task provenance.
    suppliedName: { type: String, trim: true, maxlength: 120 },
    suppliedEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    suppliedPhone: { type: String, trim: true, maxlength: 32 },
    applyTokenHash: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: 64,
      maxlength: 64,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
      select: false,
      required: function (this: unknown) {
        return (this as { source?: unknown }).source === 'apply_page'
      },
    },
    actorMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      immutable: true,
    },
    actorName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    status: {
      type: String,
      enum: HIRE_INTAKE_TASK_STATUSES,
      required: true,
      default: 'queued',
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    claimToken: { type: String, maxlength: 80 },
    claimedAt: { type: Date },
    leaseExpiresAt: { type: Date },
    nextAttemptAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    lastErrorAt: { type: Date },
    queuedAt: { type: Date, required: true, default: () => new Date(), immutable: true },
    statusChangedAt: { type: Date, required: true, default: () => new Date() },
    needsIdentityAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate' },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication' },
  },
  // Refuse an accidental raw apply-token field instead of quietly stripping it.
  { timestamps: true, strict: 'throw' },
)

// Lease claim and job-status history reads must always begin with tenancy.
HireIntakeTaskSchema.index({
  workspaceId: 1,
  status: 1,
  nextAttemptAt: 1,
  leaseExpiresAt: 1,
  queuedAt: 1,
  _id: 1,
})
HireIntakeTaskSchema.index({ workspaceId: 1, jobId: 1, status: 1, queuedAt: -1 })

export const HireIntakeTask: Model<IHireIntakeTask> =
  mongoose.models.HireIntakeTask ||
  mongoose.model<IHireIntakeTask>('HireIntakeTask', HireIntakeTaskSchema)
