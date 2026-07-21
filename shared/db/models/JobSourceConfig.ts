import mongoose, { Schema, Document, Model } from 'mongoose'

export type JobSourceHealth = 'active' | 'degraded' | 'quarantined' | 'dead' | 'revoked'
export type JobSourceControlAction = 'revoke' | 'restore'

export interface IJobSourceRequestBudget {
  perRunRequestCap: number
  dailyRequestCap: number
  monthlyRequestCap: number
}

export interface IJobSourceValidation {
  operationId: string
  controlRevision: number
  operationalRevision: number
  status: 'healthy' | 'failed'
  credentialStatus: 'not-required' | 'configured' | 'missing' | 'rejected'
  usablePostings: number
  requestAttempts: number
  errorCode?: string
  checkedAt: Date
}

export interface IJobSourceLastControl {
  revision: number
  operationId: string
  action: JobSourceControlAction
  actorUserId: mongoose.Types.ObjectId
  reason: string
  at: Date
}

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
  /** Human company name for boards whose payload rows omit one (Lever/Ashby)
   *  — feeds identity + UI; the URL slug is never user-visible. */
  displayName?: string
  enabled: boolean
  health: JobSourceHealth
  /** Monotonic legal/administrative authority epoch. Every ingest event and
   *  persistence transaction is bound to the exact value it observed. */
  controlRevision: number
  /** Operational epoch for enable/pause/settings. It is deliberately
   * independent from the alternating permanent legal-control revision. */
  operationalRevision: number
  /** Internal write-conflict fence. Ingest transactions physically update
   *  this field so a concurrent control transaction has a total order with
   *  all posting writes. It has no product meaning. */
  ingestWriteSeq: number
  /** Latest durable control summary. The append-only history lives in
   *  JobSourceControlAudit and is written in the same transaction. */
  lastControl?: IJobSourceLastControl
  cadenceMinutes: number
  requestBudget: IJobSourceRequestBudget
  minIndiaPostings?: number
  emptyStreak: number
  failStreak: number
  /** Consecutive healthy weekly probes — 2 recover a quarantined board (§4.4). */
  healthyProbeStreak: number
  llmVerdictOptOut: boolean
  lastSyncAt?: Date
  lastHealthyProbeAt?: Date
  /** Probe evidence is usable only while it names the current operational
   * revision; a settings/lifecycle change makes it stale automatically. */
  lastValidation?: IJobSourceValidation
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
    displayName: { type: String },
    enabled: { type: Boolean, default: false },
    health: { type: String, enum: ['active', 'degraded', 'quarantined', 'dead', 'revoked'], default: 'active' },
    controlRevision: { type: Number, default: 0, min: 0 },
    operationalRevision: { type: Number, default: 0, min: 0 },
    ingestWriteSeq: { type: Number, default: 0, min: 0 },
    lastControl: {
      type: new Schema<IJobSourceLastControl>(
        {
          revision: { type: Number, required: true, min: 1 },
          operationId: { type: String, required: true },
          action: { type: String, enum: ['revoke', 'restore'], required: true },
          actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          reason: { type: String, required: true, maxlength: 1000 },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    cadenceMinutes: { type: Number, default: 1440 },
    requestBudget: {
      type: new Schema<IJobSourceRequestBudget>(
        {
          perRunRequestCap: { type: Number, required: true, min: 0 },
          dailyRequestCap: { type: Number, required: true, min: 0 },
          monthlyRequestCap: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      default: () => ({ perRunRequestCap: 0, dailyRequestCap: 0, monthlyRequestCap: 0 }),
    },
    minIndiaPostings: { type: Number },
    emptyStreak: { type: Number, default: 0 },
    failStreak: { type: Number, default: 0 },
    healthyProbeStreak: { type: Number, default: 0 },
    llmVerdictOptOut: { type: Boolean, default: false },
    lastSyncAt: { type: Date },
    lastHealthyProbeAt: { type: Date },
    lastValidation: {
      type: new Schema<IJobSourceValidation>(
        {
          operationId: { type: String, required: true },
          controlRevision: { type: Number, required: true, min: 0 },
          operationalRevision: { type: Number, required: true, min: 0 },
          status: { type: String, enum: ['healthy', 'failed'], required: true },
          credentialStatus: { type: String, enum: ['not-required', 'configured', 'missing', 'rejected'], required: true },
          usablePostings: { type: Number, required: true, min: 0 },
          requestAttempts: { type: Number, required: true, min: 0 },
          errorCode: { type: String, maxlength: 100 },
          checkedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
)

JobSourceConfigSchema.index({ enabled: 1, health: 1 })

export const JobSourceConfig: Model<IJobSourceConfig> =
  mongoose.models.JobSourceConfig || mongoose.model<IJobSourceConfig>('JobSourceConfig', JobSourceConfigSchema)
