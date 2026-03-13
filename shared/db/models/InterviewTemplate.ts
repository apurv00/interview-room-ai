import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IInterviewTemplate extends Document {
  _id: mongoose.Types.ObjectId
  organizationId: mongoose.Types.ObjectId

  name: string
  description?: string
  role: 'PM' | 'SWE' | 'Sales' | 'MBA' | 'Custom'
  experienceLevel: '0-2' | '3-6' | '7+' | 'all'

  questions: Array<{
    text: string
    category: 'behavioral' | 'situational' | 'motivation' | 'technical' | 'custom'
    difficulty: 'easy' | 'medium' | 'hard'
    followUpPrompt?: string
    scoringCriteria?: string
  }>

  settings: {
    duration: number
    questionCount: number
    allowFollowUps: boolean
    pressureQuestionIndex?: number
    customSystemPrompt?: string
  }

  isActive: boolean
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const InterviewTemplateSchema = new Schema<IInterviewTemplate>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },
    description: { type: String },
    role: {
      type: String,
      enum: ['PM', 'SWE', 'Sales', 'MBA', 'Custom'],
      required: true,
    },
    experienceLevel: {
      type: String,
      enum: ['0-2', '3-6', '7+', 'all'],
      default: 'all',
    },

    questions: [
      {
        text: { type: String, required: true },
        category: {
          type: String,
          enum: ['behavioral', 'situational', 'motivation', 'technical', 'custom'],
          default: 'behavioral',
        },
        difficulty: {
          type: String,
          enum: ['easy', 'medium', 'hard'],
          default: 'medium',
        },
        followUpPrompt: { type: String },
        scoringCriteria: { type: String },
      },
    ],

    settings: {
      duration: { type: Number, default: 10 },
      questionCount: { type: Number, default: 6 },
      allowFollowUps: { type: Boolean, default: true },
      pressureQuestionIndex: { type: Number },
      customSystemPrompt: { type: String },
    },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

InterviewTemplateSchema.index({ organizationId: 1, isActive: 1 })

export const InterviewTemplate: Model<IInterviewTemplate> =
  mongoose.models.InterviewTemplate ||
  mongoose.model<IInterviewTemplate>('InterviewTemplate', InterviewTemplateSchema)
