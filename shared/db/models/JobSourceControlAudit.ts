import mongoose, { Schema, Document, Model } from 'mongoose'
import type { JobSourceControlAction, JobSourceHealth } from './JobSourceConfig'

export interface IJobSourceControlState {
  enabled: boolean
  health: JobSourceHealth
}

/**
 * Permanent, append-only evidence for legal source-control transitions.
 *
 * Unlike ProductEvent/JobIngestCycle this collection has no TTL. The audit
 * row, source authority revision, and affected-posting closure commit in one
 * Mongo transaction, so state cannot claim a revoke that its evidence lacks
 * (or vice versa).
 */
export interface IJobSourceControlAudit extends Document {
  _id: mongoose.Types.ObjectId
  sourceId: string
  operationId: string
  action: JobSourceControlAction
  actorUserId: mongoose.Types.ObjectId
  reason: string
  previousRevision: number
  revision: number
  from: IJobSourceControlState
  to: IJobSourceControlState
  affectedPostings: number
  unknownLineagePostings: number
  /** Canonical transition timestamp returned on both first execution and
   * idempotent replay. `createdAt` is only database insertion metadata. */
  occurredAt: Date
  createdAt: Date
}

const ControlStateSchema = new Schema<IJobSourceControlState>(
  {
    enabled: { type: Boolean, required: true },
    health: { type: String, enum: ['active', 'degraded', 'quarantined', 'dead', 'revoked'], required: true },
  },
  { _id: false }
)

const JobSourceControlAuditSchema = new Schema<IJobSourceControlAudit>(
  {
    sourceId: { type: String, required: true },
    operationId: { type: String, required: true },
    action: { type: String, enum: ['revoke', 'restore'], required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    previousRevision: { type: Number, required: true, min: 0 },
    revision: { type: Number, required: true, min: 1 },
    from: { type: ControlStateSchema, required: true },
    to: { type: ControlStateSchema, required: true },
    affectedPostings: { type: Number, required: true, min: 0 },
    unknownLineagePostings: { type: Number, required: true, min: 0 },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// These permanent A02 audit indexes are deliberately omitted from schema
// metadata. Runtime auto-indexing would bypass the mandatory rollout gate;
// `prepare:jobs-source-control-indexes` is their sole owner.

export const JobSourceControlAudit: Model<IJobSourceControlAudit> =
  mongoose.models.JobSourceControlAudit ||
  mongoose.model<IJobSourceControlAudit>('JobSourceControlAudit', JobSourceControlAuditSchema)
