import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_REPORT_FORMATS,
  HIRE_REPORT_KINDS,
  HIRE_REPORT_SCOPES,
  type HireReportFormat,
  type HireReportKind,
  type HireReportScope,
} from '../types'
import { hireReportExportObjectKey } from './HireReportExport'

/** A deletion-only outbox for one private Phase-5 report artifact. */
export const HIRE_REPORT_EXPORT_CLEANUP_LEASE_MS = 5 * 60 * 1000
export const HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT = 25
/** Storage work is later bounded by this and the parent export claim lease. */
export const HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS = 60 * 1000
/** A bounded provider settlement grace after a timed-out private object write. */
export const HIRE_REPORT_EXPORT_MAX_PUT_SETTLEMENT_MS =
  2 * HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS

export interface IHireReportExportCleanup extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId?: mongoose.Types.ObjectId
  reportKind: HireReportKind
  reportScope: HireReportScope
  format: HireReportFormat
  /** The immutable report ID is sufficient to derive its private key. */
  exportId: mongoose.Types.ObjectId
  requestedAt: Date
  /** Do not settle while a previously authorized export claim could still write. */
  cleanupNotBeforeAt: Date
  attempts: number
  firstSweepAt?: Date
  claimToken?: string
  leaseExpiresAt?: Date
  nextRetryAt: Date
  lastFailureAt?: Date
  createdAt: Date
  updatedAt: Date
}

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

/** Reuse the export key grammar so a tombstone can never target another object. */
function hasValidCleanupCoordinate(row: Pick<IHireReportExportCleanup,
  'workspaceId' | 'jobId' | 'reportKind' | 'reportScope' | 'format' | 'exportId'
>): boolean {
  try {
    hireReportExportObjectKey({
      workspaceId: row.workspaceId.toString(),
      reportId: row.exportId.toString(),
      reportKind: row.reportKind,
      reportScope: row.reportScope,
      format: row.format,
      ...(row.jobId ? { jobId: row.jobId.toString() } : {}),
    })
    return true
  } catch {
    return false
  }
}

const HireReportExportCleanupSchema = new Schema<IHireReportExportCleanup>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', immutable: true },
    reportKind: {
      type: String,
      enum: HIRE_REPORT_KINDS,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          return isQueryValidationContext(this) || hasValidCleanupCoordinate(this as IHireReportExportCleanup)
        },
        message: 'Report cleanup coordinates must describe one exact private report object',
      },
    },
    reportScope: { type: String, enum: HIRE_REPORT_SCOPES, required: true, immutable: true },
    format: { type: String, enum: HIRE_REPORT_FORMATS, required: true, immutable: true },
    exportId: { type: Schema.Types.ObjectId, ref: 'HireReportExport', required: true, immutable: true },
    requestedAt: { type: Date, required: true, immutable: true },
    cleanupNotBeforeAt: { type: Date, required: true, immutable: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    firstSweepAt: { type: Date },
    claimToken: { type: String, maxlength: 80, select: false },
    leaseExpiresAt: { type: Date },
    nextRetryAt: { type: Date, required: true },
    lastFailureAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// Exactly one durable deletion obligation exists for a private report object.
HireReportExportCleanupSchema.index({ workspaceId: 1, exportId: 1 }, { unique: true })
// Intentionally global: cleanup must continue after workspace deletion/hard purge.
HireReportExportCleanupSchema.index({
  firstSweepAt: 1,
  nextRetryAt: 1,
  cleanupNotBeforeAt: 1,
  leaseExpiresAt: 1,
  _id: 1,
})

export const HireReportExportCleanup: Model<IHireReportExportCleanup> =
  mongoose.models.HireReportExportCleanup ||
  mongoose.model<IHireReportExportCleanup>(
    'HireReportExportCleanup',
    HireReportExportCleanupSchema,
  )
