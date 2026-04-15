import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * Score telemetry row — captures one scoring decision per feedback
 * generation so we can audit the delta between Claude's raw overall_score
 * and the post-override deterministic formula. Written by
 * `recordScoreDelta` in `shared/services/scoreTelemetry.ts`.
 *
 * Rolling 30-day retention via `expiresAt` TTL index. No user PII beyond
 * the foreign keys; the payload stores only numeric dimensions and the
 * model/prompt metadata needed to interpret them.
 *
 * Added as part of Work Item G.1 (score telemetry baseline). This is the
 * measurement substrate that gates every subsequent scoring-rebalance
 * work item (G.8/G.9/G.10/G.11). Do not remove until G.15.
 */
export interface IScoreTelemetry extends Document {
  _id: mongoose.Types.ObjectId

  sessionId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId

  /** Which scoring call this row describes. */
  source: 'generate-feedback' | 'evaluate-answer'

  /** Task slot resolved by modelRouter (e.g. `interview.generate-feedback`). */
  taskSlot: string

  /** Model id returned by the provider (e.g. `claude-opus-4-6`). */
  modelUsed: string

  /** Claude's holistic value as-returned by the LLM (if present). */
  claudeOverallScore?: number

  /** The current deterministic formula output
   *  (aq*0.4 + comm*0.3 + eng*0.3). Retained for A/B. */
  deterministicOverallScore?: number

  /** Claude − deterministic. Sign matters: positive = Claude would
   *  have awarded more credit than the formula. */
  deltaOverall?: number

  /** Claude's per-dimension scores, snapshotted so we can analyse
   *  which dimensions drive the override effect. */
  claudeDimensions?: Record<string, number>

  /** Deterministic dimension averages after aggregation. */
  deterministicDimensions?: Record<string, number>

  /** Number of evaluations that fed into the aggregation. */
  evaluationCount?: number

  /** Total length of the user+system prompt sent to the model, in chars.
   *  Useful for diagnosing truncation risk (G.3). */
  promptLength?: number

  /** Input/output tokens as reported by the provider. */
  inputTokens?: number
  outputTokens?: number

  /** True when the provider reported stop_reason=max_tokens. */
  truncated?: boolean

  /** Reason the telemetry row was created — useful when we add more
   *  non-happy-path paths later (e.g. "inline-fallback"). */
  recordReason: 'ok' | 'claude-missing-overall' | 'parse-failed' | 'outer-catch'

  createdAt: Date
  expiresAt: Date
}

const ScoreTelemetrySchema = new Schema<IScoreTelemetry>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    source: {
      type: String,
      enum: ['generate-feedback', 'evaluate-answer'],
      required: true,
      index: true,
    },

    taskSlot: { type: String, required: true },
    modelUsed: { type: String, required: true },

    claudeOverallScore: { type: Number },
    deterministicOverallScore: { type: Number },
    deltaOverall: { type: Number, index: true },

    claudeDimensions: { type: Schema.Types.Mixed },
    deterministicDimensions: { type: Schema.Types.Mixed },

    evaluationCount: { type: Number },
    promptLength: { type: Number },
    inputTokens: { type: Number },
    outputTokens: { type: Number },
    truncated: { type: Boolean },

    recordReason: {
      type: String,
      enum: ['ok', 'claude-missing-overall', 'parse-failed', 'outer-catch'],
      required: true,
    },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// Rolling retention — Mongo auto-removes expired rows.
ScoreTelemetrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// Ad-hoc analytics queries: group by source + range scan on createdAt.
ScoreTelemetrySchema.index({ source: 1, createdAt: -1 })
ScoreTelemetrySchema.index({ createdAt: -1 })

export const ScoreTelemetry: Model<IScoreTelemetry> =
  mongoose.models.ScoreTelemetry ||
  mongoose.model<IScoreTelemetry>('ScoreTelemetry', ScoreTelemetrySchema)
