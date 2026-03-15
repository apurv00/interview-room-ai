import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IUserCompetencyState extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  competencyName: string               // e.g. "specificity", "metrics_thinking", "ownership"
  domain: string                       // domain slug or "*" for cross-domain
  currentScore: number                 // 0-100 rolling average
  confidenceInterval: number           // 0-1 (higher = more data points)
  trend: 'improving' | 'stable' | 'declining'
  evidenceCount: number                // number of evaluations contributing
  lastUpdated: Date

  // Score history for trend calculation
  scoreHistory: Array<{
    score: number
    sessionId: mongoose.Types.ObjectId
    timestamp: Date
  }>

  // Spaced repetition fields
  srLastPracticedAt?: Date
  srNextReviewAt?: Date
  srEaseFactor?: number
  srInterval?: number
  srRepetitionCount?: number

  createdAt: Date
  updatedAt: Date
}

const UserCompetencyStateSchema = new Schema<IUserCompetencyState>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    competencyName: { type: String, required: true },
    domain: { type: String, required: true, default: '*' },
    currentScore: { type: Number, default: 50, min: 0, max: 100 },
    confidenceInterval: { type: Number, default: 0, min: 0, max: 1 },
    trend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
    evidenceCount: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now },

    scoreHistory: [{
      score: { type: Number, required: true },
      sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },
      timestamp: { type: Date, default: Date.now },
    }],

    // Spaced repetition
    srLastPracticedAt: { type: Date },
    srNextReviewAt: { type: Date },
    srEaseFactor: { type: Number, default: 2.5, min: 1.3, max: 3.0 },
    srInterval: { type: Number, default: 1 },
    srRepetitionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

// Compound index: one entry per user+competency+domain
UserCompetencyStateSchema.index({ userId: 1, competencyName: 1, domain: 1 }, { unique: true })
UserCompetencyStateSchema.index({ userId: 1, currentScore: 1 })
UserCompetencyStateSchema.index({ userId: 1, srNextReviewAt: 1 })

export const UserCompetencyState: Model<IUserCompetencyState> =
  mongoose.models.UserCompetencyState ||
  mongoose.model<IUserCompetencyState>('UserCompetencyState', UserCompetencyStateSchema)
