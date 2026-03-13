import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IBenchmarkCase extends Document {
  _id: mongoose.Types.ObjectId
  caseId: string                            // e.g. "pm_hm_mid_001"
  domain: string
  interviewType: string
  seniorityBand: string

  // The test scenario
  question: string
  candidateAnswer: string

  // Expected outputs
  expectedStrengthTags: string[]
  expectedWeaknessTags: string[]
  expectedCompetencyScoreBands: Record<string, {
    min: number
    max: number
  }>
  expectedFollowUpRelevance: 'high' | 'medium' | 'low'

  // Ideal reference outputs
  idealFollowUpExamples: string[]
  idealFeedbackPoints: string[]

  // For full-session benchmarks
  isFullSession: boolean
  fullTranscript?: Array<{
    speaker: string
    text: string
  }>
  expectedOverallScoreBand: {
    min: number
    max: number
  }

  // Metadata
  category: string                          // e.g. "pm_behavioral", "swe_system_design"
  tags: string[]
  isActive: boolean

  createdAt: Date
  updatedAt: Date
}

const BenchmarkCaseSchema = new Schema<IBenchmarkCase>(
  {
    caseId: { type: String, required: true, unique: true },
    domain: { type: String, required: true },
    interviewType: { type: String, required: true },
    seniorityBand: { type: String, default: '*' },

    question: { type: String, required: true },
    candidateAnswer: { type: String, required: true },

    expectedStrengthTags: [{ type: String }],
    expectedWeaknessTags: [{ type: String }],
    expectedCompetencyScoreBands: { type: Schema.Types.Mixed, default: {} },
    expectedFollowUpRelevance: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },

    idealFollowUpExamples: [{ type: String }],
    idealFeedbackPoints: [{ type: String }],

    isFullSession: { type: Boolean, default: false },
    fullTranscript: { type: Schema.Types.Mixed },
    expectedOverallScoreBand: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 100 },
    },

    category: { type: String, required: true },
    tags: [{ type: String }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

BenchmarkCaseSchema.index({ domain: 1, interviewType: 1, isActive: 1 })
BenchmarkCaseSchema.index({ category: 1 })

export const BenchmarkCase: Model<IBenchmarkCase> =
  mongoose.models.BenchmarkCase ||
  mongoose.model<IBenchmarkCase>('BenchmarkCase', BenchmarkCaseSchema)
