import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_EXPORT_FAILURE_CODES,
  HIRE_REPORT_EXPORT_STATUSES,
  HIRE_REPORT_FORMATS,
  HIRE_REPORT_KINDS,
  HIRE_REPORT_MAX_CLOSEOUT_HIRES,
  HIRE_REPORT_MAX_COUNT,
  HIRE_REPORT_MAX_PIPELINE_JOBS,
  HIRE_REPORT_MAX_TIME_TO_CLOSE_HOURS,
  HIRE_REPORT_PIPELINE_STAGES,
  HIRE_REPORT_RECOMMENDATIONS,
  HIRE_REPORT_SCOPES,
  type HireReportExportFailureCode,
  type HireReportExportStatus,
  type HireReportFormat,
  type HireReportKind,
  type HireReportScope,
  type HireReportSnapshot,
} from '../types'

/** Private reports expire through an explicit lifecycle, never a storage URL. */
export const HIRE_REPORT_EXPORT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const HIRE_REPORT_EXPORT_LEASE_MS = 5 * 60 * 1000
export const HIRE_REPORT_EXPORT_MAX_ATTEMPTS = 5

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPORT_KEY = /^hire-report-exports\/v1\/([a-f0-9]{24})\/(pipeline_status|job_closeout)\/(workspace|[a-f0-9]{24})\/(pdf|xlsx)\/([a-f0-9]{24})\.(pdf|xlsx)$/i

export interface HireReportExportCoordinate {
  workspaceId: string
  reportId: string
  reportKind: HireReportKind
  reportScope: HireReportScope
  format: HireReportFormat
  jobId?: string
}

function hasObjectId(value: string | undefined): value is string {
  return Boolean(value && OBJECT_ID.test(value))
}

function hasSupportedCoordinateShape(coordinate: HireReportExportCoordinate): boolean {
  if (!hasObjectId(coordinate.workspaceId) || !hasObjectId(coordinate.reportId)) return false
  if (!HIRE_REPORT_KINDS.includes(coordinate.reportKind)) return false
  if (!HIRE_REPORT_SCOPES.includes(coordinate.reportScope)) return false
  if (!HIRE_REPORT_FORMATS.includes(coordinate.format)) return false
  if (coordinate.reportScope === 'workspace' && coordinate.jobId !== undefined) return false
  if (coordinate.reportScope === 'job' && !hasObjectId(coordinate.jobId)) return false
  if (coordinate.reportKind === 'job_closeout') {
    return coordinate.reportScope === 'job' && coordinate.format === 'pdf'
  }
  return true
}

/**
 * A deterministic private key binds a report to its immutable scope. It is
 * never accepted from a member request or returned from a member DTO.
 */
export function hireReportExportObjectKey(coordinate: HireReportExportCoordinate): string {
  if (!hasSupportedCoordinateShape(coordinate)) throw new InvalidHireReportExportKeyError()
  const scopeKey = coordinate.reportScope === 'workspace'
    ? 'workspace'
    : coordinate.jobId!.toLowerCase()
  return [
    'hire-report-exports',
    'v1',
    coordinate.workspaceId.toLowerCase(),
    coordinate.reportKind,
    scopeKey,
    coordinate.format,
    `${coordinate.reportId.toLowerCase()}.${coordinate.format}`,
  ].join('/')
}

export class InvalidHireReportExportKeyError extends Error {
  constructor() {
    super('Hire report export key is outside the authorized scope')
    this.name = 'InvalidHireReportExportKeyError'
  }
}

export function parseHireReportExportObjectKey(key: string): HireReportExportCoordinate | null {
  if (!key || key.length > 500 || key.includes('%') || key.includes('\\')) return null
  const match = REPORT_KEY.exec(key)
  if (!match || match[4].toLowerCase() !== match[6].toLowerCase()) return null
  const reportScope: HireReportScope = match[3].toLowerCase() === 'workspace' ? 'workspace' : 'job'
  const coordinate: HireReportExportCoordinate = {
    workspaceId: match[1].toLowerCase(),
    reportKind: match[2].toLowerCase() as HireReportKind,
    reportScope,
    format: match[4].toLowerCase() as HireReportFormat,
    reportId: match[5].toLowerCase(),
    ...(reportScope === 'job' ? { jobId: match[3].toLowerCase() } : {}),
  }
  return hasSupportedCoordinateShape(coordinate) ? coordinate : null
}

export function assertHireReportExportObjectKeyScope(
  key: string,
  coordinate: HireReportExportCoordinate,
): void {
  const parsed = parseHireReportExportObjectKey(key)
  if (
    !parsed ||
    parsed.workspaceId !== coordinate.workspaceId.toLowerCase() ||
    parsed.reportId !== coordinate.reportId.toLowerCase() ||
    parsed.reportKind !== coordinate.reportKind ||
    parsed.reportScope !== coordinate.reportScope ||
    parsed.format !== coordinate.format ||
    parsed.jobId !== coordinate.jobId?.toLowerCase()
  ) {
    throw new InvalidHireReportExportKeyError()
  }
}

export interface IHireReportExport extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  /** Required only for job-scoped pipeline and close-out reports. */
  jobId?: mongoose.Types.ObjectId
  reportKind: HireReportKind
  reportScope: HireReportScope
  format: HireReportFormat
  /** Workspace-scoped idempotency coordinate from a member request or close transaction. */
  creationOperationId: string
  /** Immutable Hire-member audit actor; this never depends on a B2C identity. */
  requestedByMemberId: mongoose.Types.ObjectId
  /** Bounded display snapshot of the Hire member at request time. */
  requestedByName: string
  /** Private deterministic object path; never selected by default or sent to members. */
  objectKey?: string
  /** Deep-allowlisted report data captured under the eventual lifecycle fence. */
  reportSnapshot?: HireReportSnapshot
  /** Privacy/lifecycle coordination only; IDs never appear in report content. */
  affectedCandidateIds: mongoose.Types.ObjectId[]
  /**
   * Immutable workspace aggregate-privacy epoch captured with a pipeline
   * snapshot. Closeout reports intentionally use their candidate coordinates
   * instead, so historical closeout policy remains separate.
   */
  privacyAggregateFenceVersion?: number
  requestedAt: Date
  expiresAt: Date
  status: HireReportExportStatus
  attempts: number
  /** Latest worker claim time; request/terminal timestamps remain durable separately. */
  generatingAt?: Date
  claimToken?: string
  leaseExpiresAt?: Date
  nextRetryAt?: Date
  readyAt?: Date
  failedAt?: Date
  expiredAt?: Date
  failureCode?: HireReportExportFailureCode
  cancelledAt?: Date
  privacyRedactedAt?: Date
  objectCleanupPendingAt?: Date
  objectCleanupCompletedAt?: Date
  objectCleanupClaimToken?: string
  objectCleanupLeaseExpiresAt?: Date
  contentSizeBytes?: number
  createdAt: Date
  updatedAt: Date
}

const RecommendationTallySchema = new Schema(
  {
    strong_yes: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
    yes: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
    no: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
    strong_no: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
  },
  { _id: false, strict: 'throw' },
)

function hasExactFixedKeys(value: unknown[], field: string, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry && typeof entry === 'object' && (entry as Record<string, unknown>)[field] === expected[index])
  )
}

const StageCountSchema = new Schema(
  {
    stage: { type: String, enum: HIRE_REPORT_PIPELINE_STAGES, required: true },
    count: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
  },
  { _id: false, strict: 'throw' },
)

const AgingCountSchema = new Schema(
  {
    bucket: { type: String, enum: HIRE_REPORT_AGING_BUCKETS, required: true },
    count: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
  },
  { _id: false, strict: 'throw' },
)

const BlockerCountSchema = new Schema(
  {
    kind: { type: String, enum: HIRE_REPORT_BLOCKER_KINDS, required: true },
    count: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
  },
  { _id: false, strict: 'throw' },
)

function hasTallyMatchingCount(value: unknown): boolean {
  const row = value as { submittedCount?: unknown; recommendations?: Record<string, unknown> }
  if (!Number.isInteger(row?.submittedCount) || (row.submittedCount as number) < 0) return false
  const tally = row.recommendations
  if (!tally || typeof tally !== 'object') return false
  const total = HIRE_REPORT_RECOMMENDATIONS.reduce((sum, key) => {
    const count = tally[key]
    return sum + (Number.isInteger(count) && (count as number) >= 0 ? (count as number) : Number.NaN)
  }, 0)
  return Number.isFinite(total) && total === row.submittedCount
}

const EvidenceSourceSchema = new Schema(
  {
    submittedCount: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
    recommendations: { type: RecommendationTallySchema, required: true },
  },
  { _id: false, strict: 'throw' },
)

EvidenceSourceSchema.path('submittedCount').validate({
  validator(this: unknown) {
    return hasTallyMatchingCount(this)
  },
  message: 'Evidence submittedCount must equal its independent recommendation tally',
})

const EvidenceSchema = new Schema(
  {
    aiAssessments: {
      type: new Schema(
        {
          completedCount: { type: Number, required: true, min: 0, max: HIRE_REPORT_MAX_COUNT },
        },
        { _id: false, strict: 'throw' },
      ),
      required: true,
    },
    humanScorecards: {
      type: new Schema(
        {
          member: { type: EvidenceSourceSchema, required: true },
          kit: { type: EvidenceSourceSchema, required: true },
        },
        { _id: false, strict: 'throw' },
      ),
      required: true,
    },
    externalVerdicts: { type: EvidenceSourceSchema, required: true },
  },
  { _id: false, strict: 'throw' },
)

/**
 * Historical report output may retain only the department's immutable display
 * coordinate. The field is optional because Phase-5 exports predate the
 * catalog and must continue to validate/read without a data migration.
 */
const DepartmentSnapshotSchema = new Schema(
  {
    id: { type: String, required: true, match: OBJECT_ID, lowercase: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  },
  { _id: false, strict: 'throw' },
)

const PipelineJobSnapshotSchema = new Schema(
  {
    jobTitle: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    department: { type: DepartmentSnapshotSchema, default: undefined },
    jobStatus: { type: String, required: true, enum: ['open', 'on_hold', 'closed'] },
    openedAt: { type: Date, required: true },
    stageCounts: {
      type: [StageCountSchema],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return hasExactFixedKeys(value, 'stage', HIRE_REPORT_PIPELINE_STAGES)
        },
        message: 'Pipeline report stage counts must include every stage exactly once in canonical order',
      },
    },
    aging: {
      type: [AgingCountSchema],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return hasExactFixedKeys(value, 'bucket', HIRE_REPORT_AGING_BUCKETS)
        },
        message: 'Pipeline report aging must include every fixed bucket exactly once in canonical order',
      },
    },
    blockers: {
      type: [BlockerCountSchema],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return hasExactFixedKeys(value, 'kind', HIRE_REPORT_BLOCKER_KINDS)
        },
        message: 'Pipeline report blockers must include every fixed category exactly once in canonical order',
      },
    },
    evidence: { type: EvidenceSchema, required: true },
  },
  { _id: false, strict: 'throw' },
)

const HiredCandidateSnapshotSchema = new Schema(
  {
    candidateName: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    hiredAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
)

/**
 * One strict union schema keeps report snapshots concrete rather than Mixed.
 * The parent validator below makes the pipeline and close-out shapes mutually
 * exclusive and binds the snapshot to the immutable export coordinates.
 */
const ReportSnapshotSchema = new Schema(
  {
    version: { type: Number, required: true, enum: [1] },
    kind: { type: String, required: true, enum: HIRE_REPORT_KINDS },
    scope: { type: String, enum: HIRE_REPORT_SCOPES },
    asOf: { type: Date, required: true },
    jobs: { type: [PipelineJobSnapshotSchema], default: undefined },
    jobTitle: { type: String, trim: true, minlength: 1, maxlength: 200 },
    department: { type: DepartmentSnapshotSchema, default: undefined },
    openedAt: { type: Date },
    closedAt: { type: Date },
    timeToCloseHours: { type: Number, min: 0, max: HIRE_REPORT_MAX_TIME_TO_CLOSE_HOURS },
    stageCounts: { type: [StageCountSchema], default: undefined },
    evidence: { type: EvidenceSchema },
    hiredCandidates: {
      type: [HiredCandidateSnapshotSchema],
      default: undefined,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length <= HIRE_REPORT_MAX_CLOSEOUT_HIRES
        },
        message: 'Close-out reports have a bounded hired-candidate list',
      },
    },
    decisionNote: { type: String, trim: true, minlength: 1, maxlength: 4_000 },
  },
  { _id: false, strict: 'throw' },
)

type ReportSnapshotShape = Record<string, unknown>

function hasPipelineSnapshotShape(snapshot: ReportSnapshotShape, row: IHireReportExport): boolean {
  const jobs = snapshot.jobs
  return (
    snapshot.version === 1 &&
    snapshot.kind === 'pipeline_status' &&
    snapshot.scope === row.reportScope &&
    Array.isArray(jobs) &&
    jobs.length >= 1 &&
    jobs.length <= HIRE_REPORT_MAX_PIPELINE_JOBS &&
    (row.reportScope !== 'job' || jobs.length === 1) &&
    snapshot.jobTitle === undefined &&
    snapshot.openedAt === undefined &&
    snapshot.closedAt === undefined &&
    snapshot.timeToCloseHours === undefined &&
    snapshot.stageCounts === undefined &&
    snapshot.evidence === undefined &&
    snapshot.hiredCandidates === undefined &&
    snapshot.decisionNote === undefined
  )
}

function hasCloseoutSnapshotShape(snapshot: ReportSnapshotShape, row: IHireReportExport): boolean {
  const openedAt = snapshot.openedAt
  const closedAt = snapshot.closedAt
  const timeToCloseHours = snapshot.timeToCloseHours
  const hires = snapshot.hiredCandidates
  return (
    snapshot.version === 1 &&
    snapshot.kind === 'job_closeout' &&
    row.reportScope === 'job' &&
    snapshot.scope === undefined &&
    typeof snapshot.jobTitle === 'string' &&
    openedAt instanceof Date &&
    closedAt instanceof Date &&
    closedAt.getTime() >= openedAt.getTime() &&
    Number.isInteger(timeToCloseHours) &&
    timeToCloseHours === Math.floor((closedAt.getTime() - openedAt.getTime()) / (60 * 60 * 1000)) &&
    Array.isArray(snapshot.stageCounts) &&
    hasExactFixedKeys(snapshot.stageCounts, 'stage', HIRE_REPORT_PIPELINE_STAGES) &&
    Boolean(snapshot.evidence) &&
    Array.isArray(hires) &&
    hires.length <= HIRE_REPORT_MAX_CLOSEOUT_HIRES &&
    typeof snapshot.decisionNote === 'string' &&
    snapshot.jobs === undefined
  )
}

function hasMatchingSnapshot(row: Pick<IHireReportExport,
  'reportKind' | 'reportScope' | 'reportSnapshot' | 'affectedCandidateIds'
>): boolean {
  const snapshot = row.reportSnapshot as unknown as ReportSnapshotShape | undefined
  if (!snapshot || typeof snapshot !== 'object') return false
  if (row.reportKind === 'pipeline_status') {
    return hasPipelineSnapshotShape(snapshot, row as IHireReportExport) && row.affectedCandidateIds.length === 0
  }
  if (!hasCloseoutSnapshotShape(snapshot, row as IHireReportExport)) return false
  const hires = snapshot.hiredCandidates as Array<Record<string, unknown>>
  return (
    row.affectedCandidateIds.length === hires.length &&
    new Set(row.affectedCandidateIds.map((id) => id.toString())).size === row.affectedCandidateIds.length
  )
}

function hasValidAggregatePrivacyFence(row: Pick<IHireReportExport,
  'reportKind' | 'privacyAggregateFenceVersion'
>): boolean {
  const version = row.privacyAggregateFenceVersion
  if (row.reportKind !== 'pipeline_status') return version === undefined
  // Existing Phase-5 exports can predate this field. The service treats a
  // missing value as epoch zero on read, while all new pipeline exports write
  // an explicit value.
  return version === undefined || (Number.isInteger(version) && version >= 0)
}

type ReportStateShape = Pick<
  IHireReportExport,
  | 'status'
  | 'claimToken'
  | 'leaseExpiresAt'
  | 'readyAt'
  | 'failedAt'
  | 'expiredAt'
  | 'cancelledAt'
>

function hasValidState(row: ReportStateShape): boolean {
  if (row.status === 'requested') {
    return !row.claimToken && !row.leaseExpiresAt && !row.readyAt && !row.expiredAt && !row.cancelledAt
  }
  if (row.status === 'generating') {
    return Boolean(row.claimToken && row.leaseExpiresAt) && !row.readyAt && !row.expiredAt && !row.cancelledAt
  }
  if (row.status === 'ready') {
    return Boolean(row.readyAt) && !row.expiredAt && !row.cancelledAt
  }
  if (row.status === 'failed') {
    return Boolean(row.failedAt) && !row.expiredAt && !row.cancelledAt
  }
  if (row.status === 'expired') {
    return Boolean(row.expiredAt) && !row.cancelledAt
  }
  return row.status === 'cancelled' && Boolean(row.cancelledAt)
}

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

function hasBoundedExpiry(row: Pick<IHireReportExport, 'requestedAt' | 'expiresAt'>): boolean {
  return (
    row.requestedAt instanceof Date &&
    row.expiresAt instanceof Date &&
    row.expiresAt.getTime() > row.requestedAt.getTime() &&
    row.expiresAt.getTime() <= row.requestedAt.getTime() + HIRE_REPORT_EXPORT_EXPIRY_MS
  )
}

function hasMatchingObjectKey(row: Pick<IHireReportExport,
  '_id' | 'workspaceId' | 'jobId' | 'reportKind' | 'reportScope' | 'format' | 'objectKey'
>): boolean {
  if (!row.objectKey) return false
  try {
    return row.objectKey === hireReportExportObjectKey({
      workspaceId: row.workspaceId.toString(),
      reportId: row._id.toString(),
      reportKind: row.reportKind,
      reportScope: row.reportScope,
      format: row.format,
      ...(row.jobId ? { jobId: row.jobId.toString() } : {}),
    })
  } catch {
    return false
  }
}

function hasValidScope(row: Pick<IHireReportExport, 'reportKind' | 'reportScope' | 'format' | 'jobId'>): boolean {
  return hasSupportedCoordinateShape({
    workspaceId: '000000000000000000000000',
    reportId: '000000000000000000000000',
    reportKind: row.reportKind,
    reportScope: row.reportScope,
    format: row.format,
    ...(row.jobId ? { jobId: row.jobId.toString() } : {}),
  })
}

const HireReportExportSchema = new Schema<IHireReportExport>(
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
          return isQueryValidationContext(this) || hasValidScope(this as IHireReportExport)
        },
        message: 'Report kind, scope, format, and job coordinate are inconsistent',
      },
    },
    reportScope: { type: String, enum: HIRE_REPORT_SCOPES, required: true, immutable: true },
    format: { type: String, enum: HIRE_REPORT_FORMATS, required: true, immutable: true },
    creationOperationId: { type: String, required: true, immutable: true, match: OPERATION_ID },
    requestedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    requestedByName: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      minlength: 1,
      maxlength: 120,
    },
    objectKey: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      validate: {
        validator(this: unknown) {
          return hasMatchingObjectKey(this as IHireReportExport)
        },
        message: 'Report export object key must match immutable Hire coordinates',
      },
    },
    reportSnapshot: {
      type: ReportSnapshotSchema,
      required: true,
      immutable: true,
      select: false,
      validate: {
        validator(this: unknown) {
          return hasMatchingSnapshot(this as IHireReportExport)
        },
        message: 'Report snapshot must match its immutable report scope and privacy coordinates',
      },
    },
    affectedCandidateIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'HireCandidate', immutable: true }],
      required: true,
      default: [],
      immutable: true,
      select: false,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length <= HIRE_REPORT_MAX_CLOSEOUT_HIRES
        },
        message: 'Report candidate lifecycle coordinates are bounded',
      },
    },
    privacyAggregateFenceVersion: {
      type: Number,
      immutable: true,
      select: false,
      min: 0,
      required(this: unknown) {
        return (this as IHireReportExport).reportKind === 'pipeline_status'
      },
      validate: {
        validator(this: unknown) {
          return isQueryValidationContext(this) || hasValidAggregatePrivacyFence(this as IHireReportExport)
        },
        message: 'Only pipeline reports may carry a non-negative aggregate privacy fence version',
      },
    },
    requestedAt: { type: Date, required: true, immutable: true },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          return hasBoundedExpiry(this as IHireReportExport)
        },
        message: 'Report export expiry must be positive and bounded',
      },
    },
    status: {
      type: String,
      enum: HIRE_REPORT_EXPORT_STATUSES,
      required: true,
      default: 'requested',
      validate: {
        validator(this: unknown) {
          return isQueryValidationContext(this) || hasValidState(this as ReportStateShape)
        },
        message: 'Report export durable status and lease fields are inconsistent',
      },
    },
    attempts: { type: Number, required: true, default: 0, min: 0, max: HIRE_REPORT_EXPORT_MAX_ATTEMPTS },
    generatingAt: { type: Date },
    claimToken: { type: String, maxlength: 80, select: false },
    leaseExpiresAt: { type: Date },
    nextRetryAt: { type: Date },
    readyAt: { type: Date },
    failedAt: { type: Date },
    expiredAt: { type: Date },
    failureCode: { type: String, enum: HIRE_REPORT_EXPORT_FAILURE_CODES },
    cancelledAt: { type: Date },
    privacyRedactedAt: { type: Date },
    objectCleanupPendingAt: { type: Date },
    objectCleanupCompletedAt: { type: Date },
    objectCleanupClaimToken: { type: String, maxlength: 80, select: false },
    objectCleanupLeaseExpiresAt: { type: Date },
    contentSizeBytes: { type: Number, min: 1, max: 50 * 1024 * 1024 },
  },
  { timestamps: true, strict: 'throw' },
)

// Idempotency is scoped to the workspace, including a job-close operation.
HireReportExportSchema.index({ workspaceId: 1, creationOperationId: 1 }, { unique: true })
HireReportExportSchema.index({ workspaceId: 1, jobId: 1, createdAt: -1 })
HireReportExportSchema.index({ workspaceId: 1, status: 1, nextRetryAt: 1, leaseExpiresAt: 1, expiresAt: 1 })
HireReportExportSchema.index({ workspaceId: 1, reportKind: 1, status: 1, createdAt: -1 })
// Used only by later privacy lifecycle handling; it is not a member-read index.
HireReportExportSchema.index({ workspaceId: 1, affectedCandidateIds: 1, status: 1 })

export const HireReportExport: Model<IHireReportExport> =
  mongoose.models.HireReportExport ||
  mongoose.model<IHireReportExport>('HireReportExport', HireReportExportSchema)
