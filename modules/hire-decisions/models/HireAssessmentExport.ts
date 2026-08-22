import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_DECISION_DIMENSIONS,
  type HireDecisionView,
} from '../types'

/**
 * The assessment report is a short-lived private artifact.  Its lifetime is
 * deliberately bounded in the durable row rather than by a storage URL: only
 * a member-authorized service can ever read the object.
 */
export const HIRE_ASSESSMENT_EXPORT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const HIRE_ASSESSMENT_EXPORT_LEASE_MS = 5 * 60 * 1000
export const HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS = 5

export const HIRE_ASSESSMENT_EXPORT_STATUSES = [
  'pending',
  'generating',
  'ready',
  'failed',
  'cancelled',
] as const
export type HireAssessmentExportStatus = (typeof HIRE_ASSESSMENT_EXPORT_STATUSES)[number]

/** Persist only a stable, non-sensitive failure class; never an upstream error message. */
export const HIRE_ASSESSMENT_EXPORT_FAILURE_CODES = [
  'render_failed',
  'storage_failed',
  'finalization_failed',
] as const
export type HireAssessmentExportFailureCode =
  (typeof HIRE_ASSESSMENT_EXPORT_FAILURE_CODES)[number]

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EXPORT_KEY = /^hire-assessment-exports\/v1\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\.pdf$/i

export interface HireAssessmentExportCoordinate {
  workspaceId: string
  jobId: string
  applicationId: string
  candidateId: string
  exportId: string
}

/**
 * A deterministic key is never supplied by a caller or returned by a member
 * API.  Keeping every immutable coordinate in the path makes an accidental
 * cross-application storage read fail the storage helper's scope check.
 */
export function hireAssessmentExportObjectKey(input: HireAssessmentExportCoordinate): string {
  for (const value of Object.values(input)) {
    if (!OBJECT_ID.test(value)) throw new InvalidHireAssessmentExportKeyError()
  }
  return [
    'hire-assessment-exports',
    'v1',
    input.workspaceId.toLowerCase(),
    input.jobId.toLowerCase(),
    input.applicationId.toLowerCase(),
    input.candidateId.toLowerCase(),
    `${input.exportId.toLowerCase()}.pdf`,
  ].join('/')
}

export class InvalidHireAssessmentExportKeyError extends Error {
  constructor() {
    super('Hire assessment export key is outside the authorized scope')
    this.name = 'InvalidHireAssessmentExportKeyError'
  }
}

export function parseHireAssessmentExportObjectKey(
  key: string,
): HireAssessmentExportCoordinate | null {
  if (!key || key.length > 500 || key.includes('%') || key.includes('\\')) return null
  const match = EXPORT_KEY.exec(key)
  if (!match) return null
  return {
    workspaceId: match[1].toLowerCase(),
    jobId: match[2].toLowerCase(),
    applicationId: match[3].toLowerCase(),
    candidateId: match[4].toLowerCase(),
    exportId: match[5].toLowerCase(),
  }
}

export function assertHireAssessmentExportObjectKeyScope(
  key: string,
  coordinate: HireAssessmentExportCoordinate,
): void {
  const parsed = parseHireAssessmentExportObjectKey(key)
  if (!parsed || Object.entries(coordinate).some(([field, value]) => parsed[field as keyof HireAssessmentExportCoordinate] !== value.toLowerCase())) {
    throw new InvalidHireAssessmentExportKeyError()
  }
}

export interface IHireAssessmentExport extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  /** Workspace-scoped idempotency coordinate supplied by the member request. */
  creationOperationId: string
  /** Private deterministic object path; select-hidden and never in a DTO. */
  objectKey?: string
  /** Safe decision DTO captured at authorization; select-hidden and privacy-redactable. */
  decisionSnapshot?: HireDecisionView
  requestedAt: Date
  expiresAt: Date
  status: HireAssessmentExportStatus
  attempts: number
  claimToken?: string
  leaseExpiresAt?: Date
  nextRetryAt?: Date
  readyAt?: Date
  failedAt?: Date
  failureCode?: HireAssessmentExportFailureCode
  cancelledAt?: Date
  privacyRedactedAt?: Date
  /** Durable cancellation marker retained while repeated object cleanup runs. */
  objectCleanupPendingAt?: Date
  objectCleanupCompletedAt?: Date
  /** Internal cleanup CAS; never selected by member/status reads. */
  objectCleanupClaimToken?: string
  objectCleanupLeaseExpiresAt?: Date
  contentSizeBytes?: number
  createdAt: Date
  updatedAt: Date
}

const RecommendationTallySchema = new Schema(
  {
    strong_yes: { type: Number, required: true, min: 0 },
    yes: { type: Number, required: true, min: 0 },
    no: { type: Number, required: true, min: 0 },
    strong_no: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: 'throw' },
)

const DimensionAggregateSchema = new Schema(
  {
    key: { type: String, enum: HIRE_DECISION_DIMENSIONS, required: true },
    count: { type: Number, required: true, min: 0 },
    mean: { type: Number, min: 1, max: 5 },
    min: { type: Number, min: 1, max: 5 },
    max: { type: Number, min: 1, max: 5 },
    reviewerSpread: { type: Number, min: 0, max: 4 },
  },
  { _id: false, strict: 'throw' },
)

const HumanSourceAggregateSchema = new Schema(
  {
    count: { type: Number, required: true, min: 0 },
    recommendations: { type: RecommendationTallySchema, required: true },
    dimensions: {
      type: [DimensionAggregateSchema],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length === HIRE_DECISION_DIMENSIONS.length
        },
        message: 'Assessment decision summaries require each fixed dimension',
      },
    },
  },
  { _id: false, strict: 'throw' },
)

const HumanScorecardAggregateSchema = new Schema(
  {
    total: { type: HumanSourceAggregateSchema, required: true },
    member: { type: HumanSourceAggregateSchema, required: true },
    kit: { type: HumanSourceAggregateSchema, required: true },
  },
  { _id: false, strict: 'throw' },
)

const CandidateBriefSnapshotSchema = new Schema(
  {
    candidateName: { type: String, required: true, trim: true, maxlength: 120 },
    jobTitle: { type: String, required: true, trim: true, maxlength: 200 },
    location: { type: String, trim: true, maxlength: 160 },
    experienceYears: { type: Number, min: 0, max: 50 },
  },
  { _id: false, strict: 'throw' },
)

const AiAssessmentSnapshotSchema = new Schema(
  {
    completedAt: { type: Date, required: true },
    overallScore: { type: Number, min: 0, max: 100 },
    recommendation: { type: String, trim: true, maxlength: 120 },
    confidence: { type: String, trim: true, maxlength: 120 },
    dimensions: {
      type: [
        new Schema(
          {
            key: { type: String, required: true, trim: true, maxlength: 120 },
            label: { type: String, trim: true, maxlength: 160 },
            score: { type: Number, min: 0, max: 100 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length <= 32 && value.every((dimension) => dimension && typeof dimension === 'object')
        },
        message: 'An assessment snapshot cannot contain more than 32 AI assessments',
      },
    },
  },
  { _id: false, strict: 'throw' },
)

const CoordinatesSchema = new Schema(
  {
    workspaceId: { type: String, required: true, match: OBJECT_ID },
    applicationId: { type: String, required: true, match: OBJECT_ID },
    jobId: { type: String, required: true, match: OBJECT_ID },
    candidateId: { type: String, required: true, match: OBJECT_ID },
  },
  { _id: false, strict: 'throw' },
)

const DecisionSnapshotSchema = new Schema(
  {
    coordinates: { type: CoordinatesSchema, required: true },
    candidateBrief: { type: CandidateBriefSnapshotSchema, required: true },
    aiAssessments: {
      type: [AiAssessmentSnapshotSchema],
      required: true,
      validate: {
        validator(value: unknown[]) {
          return Array.isArray(value) && value.length <= 32
        },
        message: 'An assessment export cannot contain more than 32 AI assessments',
      },
    },
    humanScorecards: { type: HumanScorecardAggregateSchema, required: true },
    externalVerdicts: {
      type: new Schema(
        {
          count: { type: Number, required: true, min: 0 },
          recommendations: { type: RecommendationTallySchema, required: true },
        },
        { _id: false, strict: 'throw' },
      ),
      required: true,
    },
  },
  { _id: false, strict: 'throw' },
)

type ExportStateShape = Pick<
  IHireAssessmentExport,
  | 'status'
  | 'claimToken'
  | 'leaseExpiresAt'
  | 'readyAt'
  | 'failedAt'
  | 'cancelledAt'
>

function hasValidState(row: ExportStateShape): boolean {
  if (row.status === 'pending') {
    return !row.claimToken && !row.leaseExpiresAt && !row.readyAt && !row.cancelledAt
  }
  if (row.status === 'generating') {
    return Boolean(row.claimToken && row.leaseExpiresAt) && !row.readyAt && !row.cancelledAt
  }
  if (row.status === 'ready') {
    return Boolean(row.readyAt) && !row.cancelledAt
  }
  if (row.status === 'failed') {
    return Boolean(row.failedAt) && !row.cancelledAt
  }
  return row.status === 'cancelled' && Boolean(row.cancelledAt)
}

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

function hasBoundedExpiry(row: Pick<IHireAssessmentExport, 'requestedAt' | 'expiresAt'>): boolean {
  return (
    row.requestedAt instanceof Date &&
    row.expiresAt instanceof Date &&
    row.expiresAt.getTime() > row.requestedAt.getTime() &&
    row.expiresAt.getTime() <= row.requestedAt.getTime() + HIRE_ASSESSMENT_EXPORT_EXPIRY_MS
  )
}

function hasMatchingSnapshotCoordinates(row: Pick<IHireAssessmentExport,
  'workspaceId' | 'applicationId' | 'jobId' | 'candidateId' | 'decisionSnapshot'
>): boolean {
  const snapshot = row.decisionSnapshot
  return Boolean(
    snapshot &&
    snapshot.coordinates.workspaceId === row.workspaceId?.toString() &&
    snapshot.coordinates.applicationId === row.applicationId?.toString() &&
    snapshot.coordinates.jobId === row.jobId?.toString() &&
    snapshot.coordinates.candidateId === row.candidateId?.toString(),
  )
}

function hasMatchingObjectKey(row: Pick<IHireAssessmentExport,
  '_id' | 'workspaceId' | 'applicationId' | 'jobId' | 'candidateId' | 'objectKey'
>): boolean {
  if (!row.objectKey) return false
  try {
    return row.objectKey === hireAssessmentExportObjectKey({
      workspaceId: row.workspaceId.toString(),
      applicationId: row.applicationId.toString(),
      jobId: row.jobId.toString(),
      candidateId: row.candidateId.toString(),
      exportId: row._id.toString(),
    })
  } catch {
    return false
  }
}

const HireAssessmentExportSchema = new Schema<IHireAssessmentExport>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    creationOperationId: {
      type: String,
      required: true,
      immutable: true,
      match: OPERATION_ID,
    },
    objectKey: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      validate: {
        validator(this: unknown) {
          return hasMatchingObjectKey(this as IHireAssessmentExport)
        },
        message: 'Assessment export object key must match immutable Hire coordinates',
      },
    },
    decisionSnapshot: {
      type: DecisionSnapshotSchema,
      required: true,
      select: false,
      validate: {
        validator(this: unknown) {
          return hasMatchingSnapshotCoordinates(this as IHireAssessmentExport)
        },
        message: 'Assessment export snapshot must match immutable Hire coordinates',
      },
    },
    requestedAt: { type: Date, required: true, immutable: true },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          return hasBoundedExpiry(this as IHireAssessmentExport)
        },
        message: 'Assessment export expiry must be positive and bounded',
      },
    },
    status: {
      type: String,
      enum: HIRE_ASSESSMENT_EXPORT_STATUSES,
      required: true,
      default: 'pending',
      validate: {
        validator(this: unknown) {
          return isQueryValidationContext(this) || hasValidState(this as ExportStateShape)
        },
        message: 'Assessment export durable status and lease fields are inconsistent',
      },
    },
    attempts: { type: Number, required: true, default: 0, min: 0, max: HIRE_ASSESSMENT_EXPORT_MAX_ATTEMPTS },
    claimToken: { type: String, maxlength: 80, select: false },
    leaseExpiresAt: { type: Date },
    nextRetryAt: { type: Date },
    readyAt: { type: Date },
    failedAt: { type: Date },
    failureCode: { type: String, enum: HIRE_ASSESSMENT_EXPORT_FAILURE_CODES },
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

HireAssessmentExportSchema.index({ workspaceId: 1, creationOperationId: 1 }, { unique: true })
HireAssessmentExportSchema.index({ workspaceId: 1, applicationId: 1, createdAt: -1 })
HireAssessmentExportSchema.index({ workspaceId: 1, status: 1, nextRetryAt: 1, leaseExpiresAt: 1, expiresAt: 1 })
HireAssessmentExportSchema.index({ workspaceId: 1, candidateId: 1, status: 1 })
HireAssessmentExportSchema.index({ workspaceId: 1, jobId: 1, status: 1 })

export const HireAssessmentExport: Model<IHireAssessmentExport> =
  mongoose.models.HireAssessmentExport ||
  mongoose.model<IHireAssessmentExport>('HireAssessmentExport', HireAssessmentExportSchema)
