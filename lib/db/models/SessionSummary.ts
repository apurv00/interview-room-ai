import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ISessionSummary extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  sessionId: mongoose.Types.ObjectId
  domain: string
  interviewType: string
  experience: string

  // Compact session summary for prompt injection
  overallScore: number
  passProb: 'High' | 'Medium' | 'Low'

  // Per-competency scores from this session
  competencyScores: Record<string, number>

  // Key observations (compact text for prompt use)
  strengths: string[]
  weaknesses: string[]
  majorMistakes: string[]
  improvements: string[]

  // Topics covered to avoid repetition
  topicsCovered: string[]

  // Communication markers
  communicationMarkers: {
    avgWpm: number
    fillerRate: number
    ramblingIndex: number
    confidenceTrend: 'increasing' | 'stable' | 'declining'
  }

  // Session metadata
  sessionDate: Date
  durationMinutes: number

  createdAt: Date
  updatedAt: Date
}

const SessionSummarySchema = new Schema<ISessionSummary>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true, unique: true },
    domain: { type: String, required: true },
    interviewType: { type: String, required: true },
    experience: { type: String, required: true },

    overallScore: { type: Number, default: 0 },
    passProb: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' },

    competencyScores: { type: Schema.Types.Mixed, default: {} },

    strengths: [{ type: String }],
    weaknesses: [{ type: String }],
    majorMistakes: [{ type: String }],
    improvements: [{ type: String }],

    topicsCovered: [{ type: String }],

    communicationMarkers: {
      avgWpm: { type: Number, default: 0 },
      fillerRate: { type: Number, default: 0 },
      ramblingIndex: { type: Number, default: 0 },
      confidenceTrend: { type: String, enum: ['increasing', 'stable', 'declining'], default: 'stable' },
    },

    sessionDate: { type: Date, required: true },
    durationMinutes: { type: Number, default: 0 },
  },
  { timestamps: true }
)

SessionSummarySchema.index({ userId: 1, domain: 1, sessionDate: -1 })
SessionSummarySchema.index({ userId: 1, sessionDate: -1 })

export const SessionSummary: Model<ISessionSummary> =
  mongoose.models.SessionSummary ||
  mongoose.model<ISessionSummary>('SessionSummary', SessionSummarySchema)
