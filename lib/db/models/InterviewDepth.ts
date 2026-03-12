import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ScoringDimension {
  name: string
  label: string
  weight: number
}

export interface IInterviewDepth extends Document {
  _id: mongoose.Types.ObjectId
  slug: string
  label: string
  description: string
  icon: string
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number

  // AI behavior config
  systemPromptTemplate: string
  questionStrategy: string
  evaluationCriteria: string
  avatarPersona: string

  // Scoring overrides
  scoringDimensions: ScoringDimension[]

  // Domain applicability (empty = all)
  applicableDomains: string[]

  createdAt: Date
  updatedAt: Date
}

const InterviewDepthSchema = new Schema<IInterviewDepth>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    icon: { type: String, required: true },
    isBuiltIn: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },

    systemPromptTemplate: { type: String, default: '' },
    questionStrategy: { type: String, default: '' },
    evaluationCriteria: { type: String, default: '' },
    avatarPersona: { type: String, default: '' },

    scoringDimensions: [{
      name: { type: String, required: true },
      label: { type: String, required: true },
      weight: { type: Number, required: true, min: 0, max: 1 },
    }],

    applicableDomains: [{ type: String }],
  },
  { timestamps: true }
)

InterviewDepthSchema.index({ isActive: 1, sortOrder: 1 })

export const InterviewDepth: Model<IInterviewDepth> =
  mongoose.models.InterviewDepth ||
  mongoose.model<IInterviewDepth>('InterviewDepth', InterviewDepthSchema)
