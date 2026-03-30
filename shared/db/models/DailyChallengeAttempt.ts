import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IDailyChallengeAttempt extends Document {
  userId: mongoose.Types.ObjectId
  challengeDate: string // "YYYY-MM-DD"
  answer: string
  score: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
  percentile?: number
  createdAt: Date
}

const DailyChallengeAttemptSchema = new Schema<IDailyChallengeAttempt>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    challengeDate: { type: String, required: true },
    answer: { type: String, required: true },
    score: { type: Number, required: true },
    breakdown: {
      relevance: { type: Number, default: 0 },
      structure: { type: Number, default: 0 },
      specificity: { type: Number, default: 0 },
      ownership: { type: Number, default: 0 },
    },
    percentile: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

DailyChallengeAttemptSchema.index({ userId: 1, challengeDate: 1 }, { unique: true })
DailyChallengeAttemptSchema.index({ challengeDate: 1, score: -1 })
DailyChallengeAttemptSchema.index({ userId: 1 })

export const DailyChallengeAttempt: Model<IDailyChallengeAttempt> =
  mongoose.models.DailyChallengeAttempt || mongoose.model<IDailyChallengeAttempt>('DailyChallengeAttempt', DailyChallengeAttemptSchema)
