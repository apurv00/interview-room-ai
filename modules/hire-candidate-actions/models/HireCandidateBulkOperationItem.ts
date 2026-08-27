import mongoose, { Document, Model, Schema } from 'mongoose'
import { HIRE_STAGES, type HireStage } from '../../hire/models/HireApplication'

export const HIRE_CANDIDATE_BULK_ITEM_STATUSES = [
  'queued',
  'processing',
  'succeeded',
  'conflict',
  'failed',
] as const
export type HireCandidateBulkItemStatus =
  (typeof HIRE_CANDIDATE_BULK_ITEM_STATUSES)[number]

export const HIRE_CANDIDATE_BULK_ITEM_CLAIM_INDEX =
  'hire_candidate_bulk_item_claim'
export const HIRE_CANDIDATE_BULK_ITEM_APPLICATION_INDEX =
  'hire_candidate_bulk_item_application_unique'
export const HIRE_CANDIDATE_BULK_ITEM_LEASE_INDEX =
  'hire_candidate_bulk_item_lease_recovery'
export const HIRE_CANDIDATE_BULK_ITEM_ISSUE_INDEX =
  'hire_candidate_bulk_item_issue_page'
export const HIRE_CANDIDATE_BULK_ITEM_TTL_INDEX =
  'hire_candidate_bulk_item_ttl'
export const HIRE_CANDIDATE_BULK_ITEM_RETENTION_MS =
  90 * 24 * 60 * 60 * 1000

export interface IHireCandidateBulkOperationItem extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  bulkOperationId: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
  expectedStage: HireStage
  rowOperationId?: string
  status: HireCandidateBulkItemStatus
  attempts: number
  nextAttemptAt: Date
  claimToken?: string
  leaseExpiresAt?: Date
  outcomeCode?: string
  processedAt?: Date
  privacyRedactedAt?: Date
  purgeAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireCandidateBulkOperationItemSchema =
  new Schema<IHireCandidateBulkOperationItem>(
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
      bulkOperationId: {
        type: Schema.Types.ObjectId,
        ref: 'HireCandidateBulkOperation',
        required: true,
        immutable: true,
      },
      applicationId: {
        type: Schema.Types.ObjectId,
        ref: 'HireApplication',
        required: true,
        immutable: true,
      },
      expectedStage: {
        type: String,
        enum: HIRE_STAGES,
        required: true,
        immutable: true,
      },
      rowOperationId: {
        type: String,
        required: true,
        maxlength: 80,
        immutable: true,
      },
      status: {
        type: String,
        enum: HIRE_CANDIDATE_BULK_ITEM_STATUSES,
        required: true,
        default: 'queued',
      },
      attempts: { type: Number, required: true, min: 0, default: 0 },
      nextAttemptAt: { type: Date, required: true },
      claimToken: { type: String, maxlength: 80 },
      leaseExpiresAt: { type: Date },
      outcomeCode: { type: String, maxlength: 80 },
      processedAt: { type: Date },
      privacyRedactedAt: { type: Date },
      purgeAt: { type: Date },
    },
    { timestamps: true, autoCreate: false, autoIndex: false },
  )

HireCandidateBulkOperationItemSchema.index(
  { workspaceId: 1, bulkOperationId: 1, applicationId: 1 },
  {
    name: HIRE_CANDIDATE_BULK_ITEM_APPLICATION_INDEX,
    unique: true,
    partialFilterExpression: { applicationId: { $exists: true } },
  },
)
HireCandidateBulkOperationItemSchema.index(
  {
    workspaceId: 1,
    bulkOperationId: 1,
    status: 1,
    nextAttemptAt: 1,
    _id: 1,
  },
  { name: HIRE_CANDIDATE_BULK_ITEM_CLAIM_INDEX },
)
HireCandidateBulkOperationItemSchema.index(
  {
    workspaceId: 1,
    bulkOperationId: 1,
    status: 1,
    leaseExpiresAt: 1,
    _id: 1,
  },
  { name: HIRE_CANDIDATE_BULK_ITEM_LEASE_INDEX },
)
HireCandidateBulkOperationItemSchema.index(
  { workspaceId: 1, bulkOperationId: 1, status: 1, _id: 1 },
  { name: HIRE_CANDIDATE_BULK_ITEM_ISSUE_INDEX },
)
HireCandidateBulkOperationItemSchema.index(
  { purgeAt: 1 },
  { name: HIRE_CANDIDATE_BULK_ITEM_TTL_INDEX, expireAfterSeconds: 0 },
)

export const HireCandidateBulkOperationItem: Model<IHireCandidateBulkOperationItem> =
  mongoose.models.HireCandidateBulkOperationItem ||
  mongoose.model<IHireCandidateBulkOperationItem>(
    'HireCandidateBulkOperationItem',
    HireCandidateBulkOperationItemSchema,
  )
