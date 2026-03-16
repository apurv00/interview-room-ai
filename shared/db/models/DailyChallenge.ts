import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IDailyChallenge extends Document {
  date: string // "YYYY-MM-DD" unique
  question: string
  domain: string
  interviewType: string
  difficulty: 'easy' | 'medium' | 'hard'
  category: string
  targetCompetencies: string[]
  idealAnswerPoints: string[]
  commonMistakes: string[]
  participantCount: number
  avgScore: number
  createdAt: Date
}

const DailyChallengeSchema = new Schema<IDailyChallenge>(
  {
    date: { type: String, required: true, unique: true },
    question: { type: String, required: true },
    domain: { type: String, required: true },
    interviewType: { type: String, default: 'behavioral' },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    category: { type: String, default: '' },
    targetCompetencies: [{ type: String }],
    idealAnswerPoints: [{ type: String }],
    commonMistakes: [{ type: String }],
    participantCount: { type: Number, default: 0 },
    avgScore: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

DailyChallengeSchema.index({ date: 1 }, { unique: true })

export const DailyChallenge: Model<IDailyChallenge> =
  mongoose.models.DailyChallenge || mongoose.model<IDailyChallenge>('DailyChallenge', DailyChallengeSchema)
