import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * ServedProblem — server-authoritative ledger of every coding / system-design
 * problem a user has been shown, keyed {userId, kind, problemId}.
 *
 * Why it exists: the cross-session no-repeat guarantee used to hang entirely on
 * a client PATCH of InterviewSession.codingProblemId/designProblemId after
 * session create — any client failure (offline, bail-in-lobby, PATCH retry
 * exhaustion) silently dropped the record and the problem could repeat. The
 * ledger is written server-side inside the generate-problem routes (AI
 * problems can never go unrecorded) and at selection time from the interview
 * page (static picks), with the legacy InterviewSession fields kept as a
 * redundant second record.
 *
 * `problemBody` persists the full generated problem JSON for AI problems —
 * previously an AI problem's text existed nowhere but a 2000-char-clamped
 * evaluation string, so it could never be rebuilt or semantically deduped.
 *
 * Lifecycle: rows are ACCOUNT-scoped (cross-session no-repeat memory), removed
 * by the deleteUserAccount cascade. Deleting a single session redacts the
 * matching row's problemBody (deleteInterviewSession keys it via the session's
 * codingProblemId/designProblemId) but keeps the id row — otherwise a session
 * delete would silently re-enable repeats of a problem the user already saw.
 */
export interface IServedProblem extends Document {
  _id: mongoose.Types.ObjectId

  userId: mongoose.Types.ObjectId
  kind: 'coding' | 'system-design'
  problemId: string
  title: string
  domain?: string
  difficulty?: 'easy' | 'medium' | 'hard'
  source: 'static' | 'ai'
  /** Full problem JSON — AI-generated problems only (static bodies live in code) */
  problemBody?: unknown
  servedAt: Date
}

const ServedProblemSchema = new Schema<IServedProblem>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['coding', 'system-design'], required: true },
    problemId: { type: String, required: true, maxlength: 200 },
    title: { type: String, default: '', maxlength: 200 },
    // 100 matches the CMS domain-slug validator cap.
    domain: { type: String, maxlength: 100 },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    source: { type: String, enum: ['static', 'ai'], required: true },
    problemBody: { type: Schema.Types.Mixed },
    servedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
)

// One row per problem per user per kind — concurrent double-writes (two tabs)
// collapse to a single row via upsert against this index.
ServedProblemSchema.index({ userId: 1, kind: 1, problemId: 1 }, { unique: true })
// Exclusion reads: most-recently-served-first for a user+kind.
ServedProblemSchema.index({ userId: 1, kind: 1, servedAt: -1 })

export const ServedProblem: Model<IServedProblem> =
  mongoose.models.ServedProblem ||
  mongoose.model<IServedProblem>('ServedProblem', ServedProblemSchema)
