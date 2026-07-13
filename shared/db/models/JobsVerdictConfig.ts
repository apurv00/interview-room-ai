import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobsVerdictConfig — SINGLETON system config for the LLM verdict layer
 * (INGESTION §4.5, ruling #16). These switches are DB rows, NOT env flags
 * (founder correction 2026-07-13): both default OFF, CMS-editable, and the
 * WizardConfig singleton pattern is the repo precedent.
 *
 * `collectionEnabled` — shadow mode: verdicts are collected and reported on
 * the dashboard; serving/enforcement is untouched. `enforceEnabled` — the
 * reconciler's soft-close + demotion consumption activate. Shadow must run
 * ≥2 ingest weeks with exit criteria met before enforcement (§4.5 rollout).
 */
export interface IJobsVerdictConfig extends Document {
  _id: mongoose.Types.ObjectId
  collectionEnabled: boolean
  enforceEnabled: boolean
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
  /** USD per 1M tokens — tune in data when provider pricing shifts. */
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
  dailyVerdictCap: number
  dailyBudgetUsd: number
  monthlyBudgetUsd: number
  perCompanyDailyCap: number
  perSourceDailyCap: number
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

export const JOBS_VERDICT_DEFAULTS: JobsVerdictConfigValues = {
  collectionEnabled: false,
  enforceEnabled: false,
  dailyVerdictCap: 900,
  dailyBudgetUsd: 2.5,
  monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25,
  perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5,
  outputUsdPerMTok: 2.0,
}

interface IJobsVerdictConfigModel extends Model<IJobsVerdictConfig> {
  getConfig(): Promise<JobsVerdictConfigValues>
}

const JobsVerdictConfigSchema = new Schema<IJobsVerdictConfig>(
  {
    collectionEnabled: { type: Boolean, default: false },
    enforceEnabled: { type: Boolean, default: false },
    dailyVerdictCap: { type: Number, default: JOBS_VERDICT_DEFAULTS.dailyVerdictCap, min: 0 },
    dailyBudgetUsd: { type: Number, default: JOBS_VERDICT_DEFAULTS.dailyBudgetUsd, min: 0 },
    monthlyBudgetUsd: { type: Number, default: JOBS_VERDICT_DEFAULTS.monthlyBudgetUsd, min: 0 },
    perCompanyDailyCap: { type: Number, default: JOBS_VERDICT_DEFAULTS.perCompanyDailyCap, min: 0 },
    perSourceDailyCap: { type: Number, default: JOBS_VERDICT_DEFAULTS.perSourceDailyCap, min: 0 },
    inputUsdPerMTok: { type: Number, default: JOBS_VERDICT_DEFAULTS.inputUsdPerMTok, min: 0 },
    outputUsdPerMTok: { type: Number, default: JOBS_VERDICT_DEFAULTS.outputUsdPerMTok, min: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

// Singleton helper — the single config doc, or safe OFF defaults.
JobsVerdictConfigSchema.statics.getConfig = async function (): Promise<JobsVerdictConfigValues> {
  const doc = await this.findOne().lean()
  if (!doc) return { ...JOBS_VERDICT_DEFAULTS }
  return {
    collectionEnabled: doc.collectionEnabled ?? false,
    enforceEnabled: doc.enforceEnabled ?? false,
    dailyVerdictCap: doc.dailyVerdictCap ?? JOBS_VERDICT_DEFAULTS.dailyVerdictCap,
    dailyBudgetUsd: doc.dailyBudgetUsd ?? JOBS_VERDICT_DEFAULTS.dailyBudgetUsd,
    monthlyBudgetUsd: doc.monthlyBudgetUsd ?? JOBS_VERDICT_DEFAULTS.monthlyBudgetUsd,
    perCompanyDailyCap: doc.perCompanyDailyCap ?? JOBS_VERDICT_DEFAULTS.perCompanyDailyCap,
    perSourceDailyCap: doc.perSourceDailyCap ?? JOBS_VERDICT_DEFAULTS.perSourceDailyCap,
    inputUsdPerMTok: doc.inputUsdPerMTok ?? JOBS_VERDICT_DEFAULTS.inputUsdPerMTok,
    outputUsdPerMTok: doc.outputUsdPerMTok ?? JOBS_VERDICT_DEFAULTS.outputUsdPerMTok,
  }
}

export const JobsVerdictConfig: IJobsVerdictConfigModel =
  (mongoose.models.JobsVerdictConfig as IJobsVerdictConfigModel) ||
  mongoose.model<IJobsVerdictConfig, IJobsVerdictConfigModel>('JobsVerdictConfig', JobsVerdictConfigSchema)
