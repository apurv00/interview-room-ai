import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * JobIngestCycle — per-run telemetry row, 30d TTL (INGESTION §4.6).
 * `kind` discriminates sync runs from LLM-verdict runs (ruling #16); the
 * per-rule drop counters are the false-positive audit trail (ruling #12),
 * and the llm block's reason-coded counters + the two disagreement signals
 * (llm-flagged-clean-row / llm-cleared-flagged-row) are its LLM parallel.
 * ScoreTelemetry precedent: explicit expiresAt + TTL 0, createdAt-only.
 */
export interface IJobIngestCycle extends Document {
  _id: mongoose.Types.ObjectId
  kind: 'sync' | 'llm-verdict' | 'link-check'
  sourceId?: string
  /** Audited manual operation correlation; scheduled cycles omit it. */
  operationId?: string
  startedAt: Date
  finishedAt?: Date
  // sync counters
  fetched?: number
  normalized?: number
  driftNulls?: number
  drops?: Record<string, number>
  flagged?: Record<string, number>
  newCount?: number
  merged?: number
  refreshed?: number
  /** Rows that failed at the store layer (isolated per-row; health-relevant). */
  storeErrors?: number
  closed?: number
  dupCollapsedPct?: number
  quotaSpent?: number
  /** A local hard rail stopped outbound work. Partial persisted yield remains
   * visible without misclassifying the provider as unhealthy. */
  requestStopReason?: 'quota-exhausted' | 'quota-unavailable'
  stubRate?: number
  healthTransitions?: string[]
  // llm-verdict counters (ruling #16)
  // link-check counters (ruling #22)
  linkCheck?: {
    checked: number
    dead: number
    alive: number
    unverifiable: number
    closedNow: number
  }
  llm?: {
    requested: number
    scored: number
    cacheHits: number
    errors: number
    timeouts: number
    softClosed: number
    verdictDistribution: { genuine: number; suspicious: number; fraud: number }
    reasonCodeCounts: Record<string, number>
    bySource: Record<string, Record<string, number>>
    llmFlaggedCleanRow: number
    llmClearedFlaggedRow: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    epoch: string
    /** WHY rows didn't score — ineligible/attempts-cap/opted-out/
     *  hash-match/superseded/budget:<reason> (2026-07-16 stall lesson). */
    skips?: Record<string, number>
  }
  expiresAt: Date
  createdAt: Date
}

const TELEMETRY_TTL_DAYS = 30

const JobIngestCycleSchema = new Schema<IJobIngestCycle>(
  {
    kind: { type: String, enum: ['sync', 'llm-verdict', 'link-check'], required: true },
    sourceId: { type: String },
    operationId: { type: String },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    fetched: { type: Number },
    normalized: { type: Number },
    driftNulls: { type: Number },
    drops: { type: Schema.Types.Mixed },
    flagged: { type: Schema.Types.Mixed },
    newCount: { type: Number },
    merged: { type: Number },
    refreshed: { type: Number },
    storeErrors: { type: Number },
    closed: { type: Number },
    dupCollapsedPct: { type: Number },
    quotaSpent: { type: Number },
    requestStopReason: { type: String, enum: ['quota-exhausted', 'quota-unavailable'] },
    stubRate: { type: Number },
    healthTransitions: { type: [String], default: undefined },
    llm: { type: Schema.Types.Mixed },
    linkCheck: { type: Schema.Types.Mixed },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + TELEMETRY_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

JobIngestCycleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
JobIngestCycleSchema.index({ kind: 1, sourceId: 1, createdAt: -1 })

export const JobIngestCycle: Model<IJobIngestCycle> =
  mongoose.models.JobIngestCycle || mongoose.model<IJobIngestCycle>('JobIngestCycle', JobIngestCycleSchema)
