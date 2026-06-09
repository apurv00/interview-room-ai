import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IInterviewDomain extends Document {
  _id: mongoose.Types.ObjectId
  slug: string
  label: string
  shortLabel: string
  icon: string
  description: string
  color: string
  /**
   * Legacy free-form category label. Retained for backward compatibility
   * (the current DomainSelector still reads it) until the UI migrates to
   * `categorySlug`. No longer enum-constrained — the old enum was dead
   * (findOneAndUpdate upserts skip validators) and disagreed with the data.
   */
  category: string
  /** References Category.slug — the data-driven taxonomy bucket. */
  categorySlug?: string
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number

  // AI config
  systemPromptContext: string
  sampleQuestions: string[]
  evaluationEmphasis: string[]

  // Phase 1: Extended scenario config
  defaultRubricId?: string                          // links to EvaluationRubric
  competencyTaxonomy: string[]                      // domain-specific competencies
  difficultyRules?: {
    entryLevel: { minDifficulty: string; maxDifficulty: string }
    midLevel: { minDifficulty: string; maxDifficulty: string }
    seniorLevel: { minDifficulty: string; maxDifficulty: string }
  }
  followUpStyle: 'breadth_first' | 'depth_first' | 'adaptive'
  questionStyle: 'conversational' | 'probing' | 'structured' | 'challenging'

  createdAt: Date
  updatedAt: Date
}

const InterviewDomainSchema = new Schema<IInterviewDomain>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    shortLabel: { type: String, required: true, trim: true },
    icon: { type: String, required: true },
    description: { type: String, required: true },
    color: { type: String, default: 'indigo' },
    // Legacy label, kept until the UI migrates to categorySlug. Enum removed:
    // it was inert (no runValidators on the seed upserts) and excluded the
    // 'product'/'general' values actually in use.
    category: { type: String, required: true },
    // Data-driven taxonomy reference → Category.slug.
    categorySlug: { type: String, index: true },
    isBuiltIn: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },

    systemPromptContext: { type: String, default: '' },
    sampleQuestions: [{ type: String }],
    evaluationEmphasis: [{ type: String }],

    // Phase 1: Extended scenario config
    defaultRubricId: { type: String },
    competencyTaxonomy: [{ type: String }],
    difficultyRules: {
      entryLevel: {
        minDifficulty: { type: String, default: 'easy' },
        maxDifficulty: { type: String, default: 'medium' },
      },
      midLevel: {
        minDifficulty: { type: String, default: 'medium' },
        maxDifficulty: { type: String, default: 'medium_high' },
      },
      seniorLevel: {
        minDifficulty: { type: String, default: 'medium_high' },
        maxDifficulty: { type: String, default: 'hard' },
      },
    },
    followUpStyle: { type: String, enum: ['breadth_first', 'depth_first', 'adaptive'], default: 'adaptive' },
    questionStyle: { type: String, enum: ['conversational', 'probing', 'structured', 'challenging'], default: 'probing' },
  },
  { timestamps: true }
)

InterviewDomainSchema.index({ isActive: 1, sortOrder: 1 })

export const InterviewDomain: Model<IInterviewDomain> =
  mongoose.models.InterviewDomain ||
  mongoose.model<IInterviewDomain>('InterviewDomain', InterviewDomainSchema)
