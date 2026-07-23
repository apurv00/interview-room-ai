import mongoose, { Schema, type Document, type Model } from 'mongoose'
import type { JobsVerdictConfigState } from './JobsVerdictConfig'
import {
  JOBS_VERDICT_CONFIG_LIMITS,
  jobsVerdictConfigIssueOf,
} from '../../validators/jobsVerdictConfigLimits'

export const JOBS_VERDICT_CONFIG_ACTIONS = ['update', 'rollback'] as const
export type JobsVerdictConfigAction = (typeof JOBS_VERDICT_CONFIG_ACTIONS)[number]

/** Append-only evidence for every governed verdict-config transition. */
export interface IJobsVerdictConfigAudit extends Document<string> {
  /** The caller-supplied operation id is also the unique document id. */
  _id: string
  action: JobsVerdictConfigAction
  commandHash: string
  actorUserId: mongoose.Types.ObjectId
  reason: string
  previousRevision: number
  revision: number
  targetRevision?: number
  from: JobsVerdictConfigState
  to: JobsVerdictConfigState
  occurredAt: Date
  createdAt: Date
}

const ConfigStateSchema = new Schema<JobsVerdictConfigState>(
  {
    collectionEnabled: { type: Boolean, required: true },
    enforceEnabled: { type: Boolean, required: true },
    rankingEnabled: { type: Boolean, required: true },
    dailyVerdictCap: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.max,
      validate: { validator: Number.isSafeInteger, message: 'dailyVerdictCap must be an integer' },
    },
    dailyBudgetUsd: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.max,
    },
    monthlyBudgetUsd: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.max,
    },
    perCompanyDailyCap: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.max,
      validate: { validator: Number.isSafeInteger, message: 'perCompanyDailyCap must be an integer' },
    },
    perSourceDailyCap: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.max,
      validate: { validator: Number.isSafeInteger, message: 'perSourceDailyCap must be an integer' },
    },
    inputUsdPerMTok: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.max,
    },
    outputUsdPerMTok: {
      type: Number,
      required: true,
      min: JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.max,
    },
    notes: { type: String, maxlength: 2000 },
  },
  { _id: false },
)

ConfigStateSchema.pre('validate', function () {
  const issue = jobsVerdictConfigIssueOf(this)
  if (issue) this.invalidate('config', issue)
})

const JobsVerdictConfigAuditSchema = new Schema<IJobsVerdictConfigAudit>(
  {
    _id: { type: String, required: true, immutable: true },
    action: { type: String, enum: JOBS_VERDICT_CONFIG_ACTIONS, required: true, immutable: true },
    commandHash: { type: String, required: true, immutable: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    reason: { type: String, required: true, maxlength: 1000, immutable: true },
    previousRevision: { type: Number, required: true, min: 0, immutable: true },
    revision: { type: Number, required: true, min: 1, immutable: true },
    targetRevision: { type: Number, min: 0, immutable: true },
    from: { type: ConfigStateSchema, required: true, immutable: true },
    to: { type: ConfigStateSchema, required: true, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

JobsVerdictConfigAuditSchema.index(
  { revision: 1 },
  { name: 'jobs_verdict_config_revision_uq', unique: true },
)

export const JobsVerdictConfigAudit: Model<IJobsVerdictConfigAudit> =
  (mongoose.models.JobsVerdictConfigAudit as Model<IJobsVerdictConfigAudit>) ||
  mongoose.model<IJobsVerdictConfigAudit>('JobsVerdictConfigAudit', JobsVerdictConfigAuditSchema)
