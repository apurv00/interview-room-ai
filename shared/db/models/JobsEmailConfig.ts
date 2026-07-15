import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobsEmailConfig — SINGLETON switches for the jobs email wave (EMAILS.md
 * §2 guard 4). DB rows, never env flags (founder ruling 2026-07-13); every
 * stream defaults OFF so deploys are inert and enablement is a deliberate
 * per-stream founder action via /api/cms/jobs-ingest/email.
 *
 * e3Enabled additionally requires the wave-1.5 precondition (bounce/
 * complaint webhook suppression) before it may be flipped — enforced by
 * ops discipline + the dashboard note, not code (the switch exists so the
 * dashboard can show it as parked).
 */
export interface IJobsEmailConfig extends Document {
  _id: mongoose.Types.ObjectId
  e0Enabled: boolean
  e1Enabled: boolean
  e2Enabled: boolean
  e3Enabled: boolean
  e4Enabled: boolean
  /** Max solicitation emails per user per rolling 7 days (e0/e2 exempt). */
  globalWeeklyCap: number
  updatedBy?: mongoose.Types.ObjectId
  notes?: string
  createdAt: Date
  updatedAt: Date
}

export interface JobsEmailConfigValues {
  e0Enabled: boolean
  e1Enabled: boolean
  e2Enabled: boolean
  e3Enabled: boolean
  e4Enabled: boolean
  globalWeeklyCap: number
}

export const JOBS_EMAIL_DEFAULTS: JobsEmailConfigValues = {
  e0Enabled: false,
  e1Enabled: false,
  e2Enabled: false,
  e3Enabled: false,
  e4Enabled: false,
  globalWeeklyCap: 3,
}

interface IJobsEmailConfigModel extends Model<IJobsEmailConfig> {
  getConfig(): Promise<JobsEmailConfigValues>
}

const JobsEmailConfigSchema = new Schema<IJobsEmailConfig>(
  {
    e0Enabled: { type: Boolean, default: false },
    e1Enabled: { type: Boolean, default: false },
    e2Enabled: { type: Boolean, default: false },
    e3Enabled: { type: Boolean, default: false },
    e4Enabled: { type: Boolean, default: false },
    globalWeeklyCap: { type: Number, default: JOBS_EMAIL_DEFAULTS.globalWeeklyCap, min: 0, max: 20 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

// Singleton helper — the single config doc, or safe OFF defaults.
JobsEmailConfigSchema.statics.getConfig = async function (): Promise<JobsEmailConfigValues> {
  const doc = await this.findOne().lean()
  if (!doc) return { ...JOBS_EMAIL_DEFAULTS }
  return {
    e0Enabled: doc.e0Enabled ?? false,
    e1Enabled: doc.e1Enabled ?? false,
    e2Enabled: doc.e2Enabled ?? false,
    e3Enabled: doc.e3Enabled ?? false,
    e4Enabled: doc.e4Enabled ?? false,
    globalWeeklyCap: doc.globalWeeklyCap ?? JOBS_EMAIL_DEFAULTS.globalWeeklyCap,
  }
}

export const JobsEmailConfig: IJobsEmailConfigModel =
  (mongoose.models.JobsEmailConfig as IJobsEmailConfigModel) ||
  mongoose.model<IJobsEmailConfig, IJobsEmailConfigModel>('JobsEmailConfig', JobsEmailConfigSchema)
