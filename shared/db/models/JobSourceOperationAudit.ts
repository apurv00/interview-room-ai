import mongoose, { Schema, type Document, type Model } from 'mongoose'
import type { JobSourceHealth } from './JobSourceConfig'

export const JOB_SOURCE_OPERATION_ACTIONS = [
  'bootstrap',
  'enable',
  'pause',
  'update-settings',
  'run-now',
  'validate',
] as const

export type JobSourceOperationAction = typeof JOB_SOURCE_OPERATION_ACTIONS[number]

export interface IJobSourceOperationState {
  enabled: boolean
  health: JobSourceHealth
  /** Legal authority epoch that made this command valid. Dispatch replays use
   * this persisted value, never whatever epoch happens to be current later. */
  controlRevision: number
  operationalRevision: number
  /** Hash of every mutable source-policy field at this authority epoch. */
  policyHash: string
}

/** Permanent, non-expiring operator command evidence. Every command field is
 * immutable; dispatch and terminal fields are one-way post-commit markers.
 * Legal revoke/restore remains exclusively in JobSourceControlAudit. */
export interface IJobSourceOperationAudit extends Document {
  _id: mongoose.Types.ObjectId
  operationId: string
  action: JobSourceOperationAction
  sourceId?: string
  actorUserId: mongoose.Types.ObjectId
  reason?: string
  commandHash: string
  /** Sanitized operator-visible settings delta. Credential names/values and
   * other environment data are never accepted into this object. */
  changes?: Record<string, unknown>
  from?: IJobSourceOperationState
  to?: IJobSourceOperationState
  dispatchedAt?: Date
  outcome?: 'succeeded' | 'failed'
  errorCode?: string
  completedAt?: Date
  occurredAt: Date
  createdAt: Date
}

const OperationStateSchema = new Schema<IJobSourceOperationState>(
  {
    enabled: { type: Boolean, required: true },
    health: { type: String, enum: ['active', 'degraded', 'quarantined', 'dead', 'revoked'], required: true },
    controlRevision: { type: Number, required: true, min: 0 },
    operationalRevision: { type: Number, required: true, min: 0 },
    policyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  },
  { _id: false },
)

const JobSourceOperationAuditSchema = new Schema<IJobSourceOperationAudit>(
  {
    operationId: { type: String, required: true },
    action: { type: String, enum: JOB_SOURCE_OPERATION_ACTIONS, required: true },
    sourceId: { type: String },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, maxlength: 1000 },
    commandHash: { type: String, required: true },
    changes: { type: Schema.Types.Mixed },
    from: { type: OperationStateSchema },
    to: { type: OperationStateSchema },
    dispatchedAt: { type: Date },
    outcome: { type: String, enum: ['succeeded', 'failed'] },
    errorCode: { type: String, maxlength: 100 },
    completedAt: { type: Date },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// Explicit bootstrap/index preparation owns these permanent audit indexes.
export const JobSourceOperationAudit: Model<IJobSourceOperationAudit> =
  mongoose.models.JobSourceOperationAudit ||
  mongoose.model<IJobSourceOperationAudit>('JobSourceOperationAudit', JobSourceOperationAuditSchema)
