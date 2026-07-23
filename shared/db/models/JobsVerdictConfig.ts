import mongoose, { Schema, Document, Model } from 'mongoose'
import {
  JOBS_VERDICT_CONFIG_LIMITS,
  jobsVerdictConfigIssueOf,
} from '../../validators/jobsVerdictConfigLimits'

/**
 * JobsVerdictConfig — SINGLETON system config for the LLM verdict layer
 * (INGESTION §4.5, ruling #16). These switches are DB rows, NOT env flags
 * (founder correction 2026-07-13): switches default OFF, CMS-editable, and the
 * WizardConfig singleton pattern is the repo precedent.
 *
 * `collectionEnabled` — shadow mode: verdicts are collected and reported on
 * the dashboard; serving/enforcement is untouched. `enforceEnabled` — fraud
 * soft-close consumption. `rankingEnabled` is a separate, currently parked
 * post-GA ranking switch, so fraud enforcement cannot activate ranking.
 */
export interface IJobsVerdictConfig extends Document {
  _id: mongoose.Types.ObjectId
  revision: number
  /** Internal transaction write-conflict fence for serving mutations that
   * depend on this exact configuration revision. */
  decisionWriteSeq: number
  collectionEnabled: boolean
  enforceEnabled: boolean
  rankingEnabled: boolean
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
  /** Conservative USD-per-1M floors; route-specific safety floors may be higher. */
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  updatedBy?: mongoose.Types.ObjectId
  notes?: string
  createdAt: Date
  updatedAt: Date
}

export interface JobsVerdictConfigValues {
  collectionEnabled: boolean
  enforceEnabled: boolean
  rankingEnabled: boolean
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

export interface JobsVerdictConfigState extends JobsVerdictConfigValues {
  notes?: string
}

export interface JobsVerdictConfigSnapshot extends JobsVerdictConfigState {
  revision: number
}

/** Fixed ObjectId avoids a second singleton row without requiring a new index. */
export const JOBS_VERDICT_CONFIG_ID = '83ae5b7b13b17e7baf75ce99'

export const JOBS_VERDICT_DEFAULTS: JobsVerdictConfigValues = {
  collectionEnabled: false,
  enforceEnabled: false,
  rankingEnabled: false,
  dailyVerdictCap: 900,
  dailyBudgetUsd: 2.5,
  monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25,
  perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5,
  outputUsdPerMTok: 2.0,
}

interface IJobsVerdictConfigModel extends Model<IJobsVerdictConfig> {
  getConfig(): Promise<JobsVerdictConfigSnapshot>
}

const JobsVerdictConfigSchema = new Schema<IJobsVerdictConfig>(
  {
    revision: {
      type: Number,
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: { validator: Number.isSafeInteger, message: 'revision must be an integer' },
    },
    decisionWriteSeq: {
      type: Number,
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: { validator: Number.isSafeInteger, message: 'decisionWriteSeq must be an integer' },
    },
    collectionEnabled: { type: Boolean, default: false },
    enforceEnabled: { type: Boolean, default: false },
    rankingEnabled: { type: Boolean, default: false },
    dailyVerdictCap: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.dailyVerdictCap,
      min: JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.dailyVerdictCap.max,
      validate: { validator: Number.isSafeInteger, message: 'dailyVerdictCap must be an integer' },
    },
    dailyBudgetUsd: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.dailyBudgetUsd,
      min: JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.dailyBudgetUsd.max,
    },
    monthlyBudgetUsd: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.monthlyBudgetUsd,
      min: JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.monthlyBudgetUsd.max,
    },
    perCompanyDailyCap: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.perCompanyDailyCap,
      min: JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.perCompanyDailyCap.max,
      validate: { validator: Number.isSafeInteger, message: 'perCompanyDailyCap must be an integer' },
    },
    perSourceDailyCap: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.perSourceDailyCap,
      min: JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.perSourceDailyCap.max,
      validate: { validator: Number.isSafeInteger, message: 'perSourceDailyCap must be an integer' },
    },
    inputUsdPerMTok: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.inputUsdPerMTok,
      min: JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.inputUsdPerMTok.max,
    },
    outputUsdPerMTok: {
      type: Number,
      default: JOBS_VERDICT_DEFAULTS.outputUsdPerMTok,
      min: JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.min,
      max: JOBS_VERDICT_CONFIG_LIMITS.outputUsdPerMTok.max,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

JobsVerdictConfigSchema.pre('validate', function () {
  const issue = jobsVerdictConfigIssueOf(jobsVerdictConfigValuesOf(this))
  if (issue) this.invalidate('config', issue)
})

type VerdictConfigDocument = Partial<JobsVerdictConfigSnapshot>

export function jobsVerdictConfigValuesOf(doc?: VerdictConfigDocument | null): JobsVerdictConfigValues {
  return {
    collectionEnabled: doc?.collectionEnabled ?? JOBS_VERDICT_DEFAULTS.collectionEnabled,
    enforceEnabled: doc?.enforceEnabled ?? JOBS_VERDICT_DEFAULTS.enforceEnabled,
    rankingEnabled: doc?.rankingEnabled ?? JOBS_VERDICT_DEFAULTS.rankingEnabled,
    dailyVerdictCap: doc?.dailyVerdictCap ?? JOBS_VERDICT_DEFAULTS.dailyVerdictCap,
    dailyBudgetUsd: doc?.dailyBudgetUsd ?? JOBS_VERDICT_DEFAULTS.dailyBudgetUsd,
    monthlyBudgetUsd: doc?.monthlyBudgetUsd ?? JOBS_VERDICT_DEFAULTS.monthlyBudgetUsd,
    perCompanyDailyCap: doc?.perCompanyDailyCap ?? JOBS_VERDICT_DEFAULTS.perCompanyDailyCap,
    perSourceDailyCap: doc?.perSourceDailyCap ?? JOBS_VERDICT_DEFAULTS.perSourceDailyCap,
    inputUsdPerMTok: doc?.inputUsdPerMTok ?? JOBS_VERDICT_DEFAULTS.inputUsdPerMTok,
    outputUsdPerMTok: doc?.outputUsdPerMTok ?? JOBS_VERDICT_DEFAULTS.outputUsdPerMTok,
  }
}

export function jobsVerdictConfigStoredNumericIssueOf(
  doc?: VerdictConfigDocument | null,
): string | null {
  return jobsVerdictConfigIssueOf(jobsVerdictConfigValuesOf(doc))
}

export function jobsVerdictConfigSnapshotOf(doc?: VerdictConfigDocument | null): JobsVerdictConfigSnapshot {
  const revision = Number.isSafeInteger(doc?.revision) && (doc?.revision as number) >= 0
    ? doc?.revision as number
    : 0
  const values = jobsVerdictConfigValuesOf(doc)
  const safeValues = jobsVerdictConfigIssueOf(values)
    ? JOBS_VERDICT_DEFAULTS
    : values
  return {
    ...safeValues,
    revision,
    ...(typeof doc?.notes === 'string' && doc.notes.length > 0 ? { notes: doc.notes } : {}),
  }
}

// Prefer the governed singleton. One legacy row remains readable until its
// first revisioned write. Multiple legacy rows are ambiguous, so workers get
// safe-OFF defaults rather than an arbitrary configuration.
JobsVerdictConfigSchema.statics.getConfig = async function (): Promise<JobsVerdictConfigSnapshot> {
  const canonical = await this.findById(JOBS_VERDICT_CONFIG_ID).lean()
  if (canonical) {
    const controlValid = Number.isSafeInteger(canonical.revision) && canonical.revision >= 0 &&
      Number.isSafeInteger(canonical.decisionWriteSeq) &&
      canonical.decisionWriteSeq >= 0 && canonical.decisionWriteSeq < Number.MAX_SAFE_INTEGER
    if (!controlValid || jobsVerdictConfigIssueOf(canonical as never)) {
      return { ...JOBS_VERDICT_DEFAULTS, revision: 0 }
    }
    return jobsVerdictConfigSnapshotOf(canonical)
  }
  const legacy = await this.find({ _id: { $ne: JOBS_VERDICT_CONFIG_ID } }).sort({ _id: 1 }).limit(2).lean()
  return jobsVerdictConfigSnapshotOf(legacy.length === 1 ? legacy[0] : null)
}

export const JobsVerdictConfig: IJobsVerdictConfigModel =
  (mongoose.models.JobsVerdictConfig as IJobsVerdictConfigModel) ||
  mongoose.model<IJobsVerdictConfig, IJobsVerdictConfigModel>('JobsVerdictConfig', JobsVerdictConfigSchema)
