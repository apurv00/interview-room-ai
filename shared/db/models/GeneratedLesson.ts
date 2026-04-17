import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IGeneratedLesson extends Document {
  _id: mongoose.Types.ObjectId
  cacheKey: string
  competency: string
  domain: string
  depth: string

  title: string
  conceptSummary: string
  conceptDeepDive: string
  example: {
    question: string
    goodAnswer: string
    annotations: string[]
  }
  keyTakeaways: string[]

  tokenBudgetUsed: number
  generatedByModel: string
  reviewStatus: 'pending' | 'approved' | 'flagged' | 'overridden'
  overrideContent?: string

  createdAt: Date
  updatedAt: Date
}

const GeneratedLessonSchema = new Schema<IGeneratedLesson>(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    competency: { type: String, required: true },
    domain: { type: String, required: true },
    depth: { type: String, required: true },

    title: { type: String, required: true },
    conceptSummary: { type: String, required: true },
    conceptDeepDive: { type: String, default: '' },
    example: {
      question: { type: String, required: true },
      goodAnswer: { type: String, required: true },
      annotations: [{ type: String }],
    },
    keyTakeaways: [{ type: String }],

    tokenBudgetUsed: { type: Number, default: 0 },
    generatedByModel: { type: String, default: '' },
    reviewStatus: {
      type: String,
      enum: ['pending', 'approved', 'flagged', 'overridden'],
      default: 'pending',
    },
    overrideContent: { type: String },
  },
  { timestamps: true }
)

GeneratedLessonSchema.index({ competency: 1, domain: 1, depth: 1 })
GeneratedLessonSchema.index({ reviewStatus: 1 })

export const GeneratedLesson: Model<IGeneratedLesson> =
  mongoose.models.GeneratedLesson ||
  mongoose.model<IGeneratedLesson>('GeneratedLesson', GeneratedLessonSchema)
