import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobsEmailConfig — SINGLETON switches for the jobs email wave (EMAILS.md
 * §2 guard 4). DB rows, never env flags (founder ruling 2026-07-13); every
 * stream defaults OFF so deploys are inert and enablement is a deliberate
 * per-stream founder action via /api/cms/jobs-ingest/email.
 *
 * E3 is deliberately absent from this active contract. The digest never
 * shipped its worker or bounce/complaint feedback loop, so exposing a switch
 * implied an operable stream that did not exist. Historical documents may
 * still contain `e3Enabled`; strict Mongoose writes and getConfig ignore it.
 */
export interface IJobsEmailConfig extends Document {
  _id: mongoose.Types.ObjectId
  /** Constant singleton key — the unique index on it makes a second config
   *  doc structurally impossible (Codex #531: an empty-filter upsert races
   *  on fresh deployments; findOne() then reads an arbitrary copy). */
  key: 'singleton'
  e0Enabled: boolean
  e1Enabled: boolean
  e2Enabled: boolean
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
  e4Enabled: boolean
  globalWeeklyCap: number
}

export const JOBS_EMAIL_DEFAULTS: JobsEmailConfigValues = {
  e0Enabled: false,
  e1Enabled: false,
  e2Enabled: false,
  e4Enabled: false,
  globalWeeklyCap: 3,
}

interface IJobsEmailConfigModel extends Model<IJobsEmailConfig> {
  getConfig(): Promise<JobsEmailConfigValues>
}

const JobsEmailConfigSchema = new Schema<IJobsEmailConfig>(
  {
    key: { type: String, default: 'singleton', enum: ['singleton'] },
    e0Enabled: { type: Boolean, default: false },
    e1Enabled: { type: Boolean, default: false },
    e2Enabled: { type: Boolean, default: false },
    e4Enabled: { type: Boolean, default: false },
    globalWeeklyCap: { type: Number, default: JOBS_EMAIL_DEFAULTS.globalWeeklyCap, min: 0, max: 20 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

JobsEmailConfigSchema.index({ key: 1 }, { unique: true })

// Singleton helper — the single config doc, or safe OFF defaults.
JobsEmailConfigSchema.statics.getConfig = async function (): Promise<JobsEmailConfigValues> {
  const doc = await this.findOne({ key: 'singleton' }).lean()
  if (!doc) return { ...JOBS_EMAIL_DEFAULTS }
  return {
    e0Enabled: doc.e0Enabled ?? false,
    e1Enabled: doc.e1Enabled ?? false,
    e2Enabled: doc.e2Enabled ?? false,
    e4Enabled: doc.e4Enabled ?? false,
    globalWeeklyCap: doc.globalWeeklyCap ?? JOBS_EMAIL_DEFAULTS.globalWeeklyCap,
  }
}

export const JobsEmailConfig: IJobsEmailConfigModel =
  (mongoose.models.JobsEmailConfig as IJobsEmailConfigModel) ||
  mongoose.model<IJobsEmailConfig, IJobsEmailConfigModel>('JobsEmailConfig', JobsEmailConfigSchema)
