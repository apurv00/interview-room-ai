import mongoose, { Document, Model, Schema } from 'mongoose'

/**
 * A deletion-only outbox for a private assessment-export object.
 *
 * It deliberately survives the parent export row and even workspace graph
 * deletion. A cancellation can therefore win while a previously authorized
 * worker is between its last fence and R2 upload: after the worker lease has
 * quiesced, this tombstone derives the exact private key and deletes it.
 * Nothing user-readable, no object key, and no decision snapshot is stored.
 */
export const HIRE_ASSESSMENT_EXPORT_CLEANUP_LEASE_MS = 5 * 60 * 1000
/** Keep the minute recovery bounded even when old deletions are retrying. */
export const HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT = 25
/**
 * A private R2 request cannot occupy a worker or socket indefinitely. The
 * upload path additionally caps this by the export claim's absolute expiry.
 */
export const HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS = 60 * 1000
/**
 * After an AbortSignal deadline, allow this bounded settlement grace for an
 * already-started PutObject to finish at the provider before deleting its
 * deterministic object and settling the one-shot tombstone.
 */
export const HIRE_ASSESSMENT_EXPORT_MAX_PUT_SETTLEMENT_MS =
  2 * HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS

export interface IHireAssessmentExportCleanup extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  /** The immutable export id is enough to derive the private key. */
  exportId: mongoose.Types.ObjectId
  requestedAt: Date
  /** Do not settle before any already-authorized worker lease is quiescent. */
  cleanupNotBeforeAt: Date
  attempts: number
  /** Undefined until the first cleanup attempt settles or is deferred. */
  firstSweepAt?: Date
  claimToken?: string
  leaseExpiresAt?: Date
  nextRetryAt: Date
  lastFailureAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireAssessmentExportCleanupSchema = new Schema<IHireAssessmentExportCleanup>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    exportId: { type: Schema.Types.ObjectId, ref: 'HireAssessmentExport', required: true, immutable: true },
    requestedAt: { type: Date, required: true, immutable: true },
    cleanupNotBeforeAt: { type: Date, required: true, immutable: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    firstSweepAt: { type: Date },
    // A claim is internal worker coordination only and is never a lifecycle
    // or member-facing value.
    claimToken: { type: String, maxlength: 80, select: false },
    leaseExpiresAt: { type: Date },
    nextRetryAt: { type: Date, required: true },
    lastFailureAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// One durable cleanup obligation exists for one exact private object.
HireAssessmentExportCleanupSchema.index({ workspaceId: 1, exportId: 1 }, { unique: true })
// This is intentionally not workspace-leading: recovery must continue after
// a workspace enters deletion_pending or its root is hard-purged.
HireAssessmentExportCleanupSchema.index({ firstSweepAt: 1, nextRetryAt: 1, cleanupNotBeforeAt: 1, leaseExpiresAt: 1, _id: 1 })

export const HireAssessmentExportCleanup: Model<IHireAssessmentExportCleanup> =
  mongoose.models.HireAssessmentExportCleanup ||
  mongoose.model<IHireAssessmentExportCleanup>(
    'HireAssessmentExportCleanup',
    HireAssessmentExportCleanupSchema,
  )
