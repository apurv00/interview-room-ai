import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IInterviewDomain extends Document {
  _id: mongoose.Types.ObjectId
  slug: string
  label: string
  shortLabel: string
  icon: string
  description: string
  color: string
  category: 'engineering' | 'business' | 'design' | 'operations'
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number

  // AI config
  systemPromptContext: string
  sampleQuestions: string[]
  evaluationEmphasis: string[]

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
    category: {
      type: String,
      enum: ['engineering', 'business', 'design', 'operations'],
      required: true,
    },
    isBuiltIn: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },

    systemPromptContext: { type: String, default: '' },
    sampleQuestions: [{ type: String }],
    evaluationEmphasis: [{ type: String }],
  },
  { timestamps: true }
)

InterviewDomainSchema.index({ isActive: 1, sortOrder: 1 })

export const InterviewDomain: Model<IInterviewDomain> =
  mongoose.models.InterviewDomain ||
  mongoose.model<IInterviewDomain>('InterviewDomain', InterviewDomainSchema)
