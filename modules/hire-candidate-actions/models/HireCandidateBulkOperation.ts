import mongoose, { Document, Model, Schema } from 'mongoose'
import { HIRE_STAGES, type HireStage } from '../../hire/models/HireApplication'

export const HIRE_CANDIDATE_BULK_ACTIONS = [
  'advance',
  'reject',
  'withdraw',
] as const
export type HireCandidateBulkAction = (typeof HIRE_CANDIDATE_BULK_ACTIONS)[number]

export const HIRE_CANDIDATE_BULK_REASON_CODES = [
  'requirements_mismatch',
  'position_closed',
  'duplicate_application',
  'candidate_withdrew',
  'role_filled',
] as const
export type HireCandidateBulkReasonCode =
  (typeof HIRE_CANDIDATE_BULK_REASON_CODES)[number]

export const HIRE_CANDIDATE_BULK_OPERATION_STATUSES = [
  'queued',
  'processing',
  'completed',
  'partial',
  'failed',
] as const
export type HireCandidateBulkOperationStatus =
  (typeof HIRE_CANDIDATE_BULK_OPERATION_STATUSES)[number]

export const HIRE_CANDIDATE_BULK_COMMUNICATION_MODES = ['none'] as const
export type HireCandidateBulkCommunicationMode =
  (typeof HIRE_CANDIDATE_BULK_COMMUNICATION_MODES)[number]

export const HIRE_CANDIDATE_BULK_DISPATCH_STATUSES = [
  'pending',
  'dispatched',
  'failed',
] as const
export type HireCandidateBulkDispatchStatus =
  (typeof HIRE_CANDIDATE_BULK_DISPATCH_STATUSES)[number]

export const HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX =
  'hire_candidate_bulk_operation_member_idempotency_unique'
export const HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX =
  'hire_candidate_bulk_operation_recovery'
export const HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX =
  'hire_candidate_bulk_operation_job_history'
export const HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX =
  'hire_candidate_bulk_operation_ttl'
export const HIRE_CANDIDATE_BULK_OPERATION_RETENTION_MS =
  365 * 24 * 60 * 60 * 1000

export interface IHireCandidateBulkOperation extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  selectionSnapshotId: mongoose.Types.ObjectId
  requestedByMemberId: mongoose.Types.ObjectId
  requestedByName: string
  clientOperationId: string
  action: HireCandidateBulkAction
  expectedStage?: HireStage
  communication: HireCandidateBulkCommunicationMode
  reasonCode?: HireCandidateBulkReasonCode
  selectionDescription: string
  status: HireCandidateBulkOperationStatus
  totalCount: number
  queuedCount: number
  processingCount: number
  succeededCount: number
  conflictCount: number
  failedCount: number
  dispatchStatus: HireCandidateBulkDispatchStatus
  dispatchAttempts: number
  nextRecoveryAt?: Date
  lastDispatchErrorCode?: 'inngest_dispatch_unavailable'
  lastDispatchErrorAt?: Date
  lastDispatchedAt?: Date
  startedAt?: Date
  completedAt?: Date
  purgeAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireCandidateBulkOperationSchema =
  new Schema<IHireCandidateBulkOperation>(
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
      selectionSnapshotId: {
        type: Schema.Types.ObjectId,
        ref: 'HireCandidateSelectionSnapshot',
        required: true,
        immutable: true,
      },
      requestedByMemberId: {
        type: Schema.Types.ObjectId,
        ref: 'HireWorkspaceMember',
        required: true,
        immutable: true,
      },
      requestedByName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 120,
        immutable: true,
      },
      clientOperationId: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80,
        immutable: true,
      },
      action: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_ACTIONS,
        required: true,
        immutable: true,
      },
      expectedStage: {
        type: String,
        enum: HIRE_STAGES,
        immutable: true,
      },
      communication: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_COMMUNICATION_MODES,
        required: true,
        immutable: true,
      },
      reasonCode: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_REASON_CODES,
        immutable: true,
      },
      selectionDescription: {
        type: String,
        required: true,
        trim: true,
        maxlength: 500,
        immutable: true,
      },
      status: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_OPERATION_STATUSES,
        required: true,
        default: 'queued',
      },
      totalCount: { type: Number, required: true, min: 1, max: 5000, immutable: true },
      queuedCount: { type: Number, required: true, min: 0 },
      processingCount: { type: Number, required: true, min: 0 },
      succeededCount: { type: Number, required: true, min: 0 },
      conflictCount: { type: Number, required: true, min: 0 },
      failedCount: { type: Number, required: true, min: 0 },
      dispatchStatus: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_DISPATCH_STATUSES,
        required: true,
        default: 'pending',
      },
      dispatchAttempts: { type: Number, required: true, min: 0, default: 0 },
      nextRecoveryAt: { type: Date },
      lastDispatchErrorCode: {
        type: String,
        enum: ['inngest_dispatch_unavailable'],
      },
      lastDispatchErrorAt: { type: Date },
      lastDispatchedAt: { type: Date },
      startedAt: { type: Date },
      completedAt: { type: Date },
      purgeAt: { type: Date },
    },
    { timestamps: true, autoCreate: false, autoIndex: false },
  )

HireCandidateBulkOperationSchema.index(
  { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
  {
    name: HIRE_CANDIDATE_BULK_OPERATION_IDEMPOTENCY_INDEX,
    unique: true,
  },
)
HireCandidateBulkOperationSchema.index(
  { workspaceId: 1, status: 1, nextRecoveryAt: 1, updatedAt: 1, _id: 1 },
  { name: HIRE_CANDIDATE_BULK_OPERATION_RECOVERY_INDEX },
)
HireCandidateBulkOperationSchema.index(
  { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
  { name: HIRE_CANDIDATE_BULK_OPERATION_JOB_HISTORY_INDEX },
)
HireCandidateBulkOperationSchema.index(
  { purgeAt: 1 },
  { name: HIRE_CANDIDATE_BULK_OPERATION_TTL_INDEX, expireAfterSeconds: 0 },
)

export const HireCandidateBulkOperation: Model<IHireCandidateBulkOperation> =
  mongoose.models.HireCandidateBulkOperation ||
  mongoose.model<IHireCandidateBulkOperation>(
    'HireCandidateBulkOperation',
    HireCandidateBulkOperationSchema,
  )
