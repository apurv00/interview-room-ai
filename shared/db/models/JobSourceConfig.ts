import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobSourceConfig — one row per ingestion source (INGESTION §4.1/§4.4).
 * Carries the health machine state (active → degraded → quarantined → dead,
 * + revoked for same-day legal objections, ruling #9) and per-source knobs.
 * `llmVerdictOptOut` is the per-source ToS lever from ruling #16 — a source
 * whose terms forbid third-party processing keeps rules-only classification.
 */
export interface IJobSourceConfig extends Document {
  _id: mongoose.Types.ObjectId
  sourceId: string
  kind: 'aggregator-api' | 'ats-board' | 'sitemap-jsonld' | 'public-api'
  /** ats-board only: greenhouse | lever | smartrecruiters | ashby | workable | bamboohr */
  atsKind?: string
  /** ats-board/sitemap: company slug or shard identifier */
  slug?: string
  enabled: boolean
  health: 'active' | 'degraded' | 'quarantined' | 'dead' | 'revoked'
  cadenceMinutes: number
  minIndiaPostings?: number
  emptyStreak: number
  failStreak: number
  /** Consecutive healthy weekly probes — 2 recover a quarantined board (§4.4). */
  healthyProbeStreak: number
  llmVerdictOptOut: boolean
  lastSyncAt?: Date
  lastHealthyProbeAt?: Date
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const JobSourceConfigSchema = new Schema<IJobSourceConfig>(
  {
    sourceId: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['aggregator-api', 'ats-board', 'sitemap-jsonld', 'public-api'], required: true },
    atsKind: { type: String },
    slug: { type: String },
    enabled: { type: Boolean, default: false },
    health: { type: String, enum: ['active', 'degraded', 'quarantined', 'dead', 'revoked'], default: 'active' },
    cadenceMinutes: { type: Number, default: 1440 },
    minIndiaPostings: { type: Number },
    emptyStreak: { type: Number, default: 0 },
    failStreak: { type: Number, default: 0 },
    healthyProbeStreak: { type: Number, default: 0 },
    llmVerdictOptOut: { type: Boolean, default: false },
    lastSyncAt: { type: Date },
    lastHealthyProbeAt: { type: Date },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

JobSourceConfigSchema.index({ enabled: 1, health: 1 })

export const JobSourceConfig: Model<IJobSourceConfig> =
  mongoose.models.JobSourceConfig || mongoose.model<IJobSourceConfig>('JobSourceConfig', JobSourceConfigSchema)
