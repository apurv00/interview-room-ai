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
  },
  { timestamps: true }
)

DrillAttemptSchema.index({ userId: 1, createdAt: -1 })

export const DrillAttempt: Model<IDrillAttempt> =
  mongoose.models.DrillAttempt ||
  mongoose.model<IDrillAttempt>('DrillAttempt', DrillAttemptSchema)
