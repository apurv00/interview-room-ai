import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IDrillAttempt extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  questionIndex: number
  question: string
  originalAnswer: string
  originalScore: number
  newAnswer: string
  newScore: number
  delta: number
  competency: string
  /**
   * Pathway P2 Wave 5 — per-dimension breakdown of the new-answer
   * scores. Already computed inside `/api/learn/drill/evaluate`
   * (LLM `scores` payload) but previously discarded after the avg
   * rolled up into `newScore`. Persisting it lets `DeltaContextNote`
   * and future per-dim drill-momentum surfaces answer "are my retries
   * fixing the specific competency I drilled?" instead of only "did
   * my retry score better overall?".
   *
   * Optional for backwards-compat: rows persisted before this field
   * existed have no breakdown. UI consumers must handle the absent
   * case (fall back to avg-delta trend).
   */
  breakdown?: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
  createdAt: Date
  updatedAt: Date
}

const DrillAttemptSchema = new Schema<IDrillAttempt>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    questionIndex: { type: Number, required: true },
    question: { type: String, required: true },
    originalAnswer: { type: String, required: true },
    originalScore: { type: Number, required: true },
    newAnswer: { type: String, required: true },
    newScore: { type: Number, required: true },
    delta: { type: Number, required: true },
    competency: { type: String, default: 'general' },
    // Wave 5 (see interface comment above). Subdoc with no _id since
    // it's a value type, not a separately-referenced document.
    breakdown: {
      type: new Schema(
        {
          relevance: { type: Number, required: true, min: 0, max: 100 },
          structure: { type: Number, required: true, min: 0, max: 100 },
          specificity: { type: Number, required: true, min: 0, max: 100 },
          ownership: { type: Number, required: true, min: 0, max: 100 },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: true }
)

DrillAttemptSchema.index({ userId: 1, createdAt: -1 })

export const DrillAttempt: Model<IDrillAttempt> =
  mongoose.models.DrillAttempt ||
  mongoose.model<IDrillAttempt>('DrillAttempt', DrillAttemptSchema)
