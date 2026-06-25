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

  // Applicability. A depth applies to a domain when BOTH lists are empty (=all),
  // OR the domain slug is in applicableDomains, OR the domain's categorySlug is
  // in applicableCategories. Categories let e.g. all Programming roles inherit
  // coding/system-design without listing each slug.
  applicableDomains: string[]
  applicableCategories: string[]

  // Experience bands this depth is offered for. Empty = all bands. Gates
  // freshers-only depths (e.g. academics → ['0-2']).
  applicableExperience: string[]

  // Phase 1: Extended config
  defaultRubricId?: string                          // links to EvaluationRubric
  competencyMapping: string[]                       // competencies this depth evaluates
  difficultyRange: { min: string; max: string }
  idealSessionLengthMin?: number
  tonePreset: 'neutral_professional' | 'warm_supportive' | 'challenging_direct' | 'collaborative'

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
    applicableCategories: [{ type: String }],
    applicableExperience: [{ type: String }],

    // Phase 1: Extended config
    defaultRubricId: { type: String },
    competencyMapping: [{ type: String }],
    difficultyRange: {
      min: { type: String, default: 'easy' },
      max: { type: String, default: 'hard' },
    },
    idealSessionLengthMin: { type: Number },
    tonePreset: {
      type: String,
      enum: ['neutral_professional', 'warm_supportive', 'challenging_direct', 'collaborative'],
      default: 'neutral_professional',
    },
  },
  { timestamps: true }
)

InterviewDepthSchema.index({ isActive: 1, sortOrder: 1 })

export const InterviewDepth: Model<IInterviewDepth> =
  mongoose.models.InterviewDepth ||
  mongoose.model<IInterviewDepth>('InterviewDepth', InterviewDepthSchema)
