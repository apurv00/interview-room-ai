import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IQuestionBank extends Document {
  _id: mongoose.Types.ObjectId
  domain: string                            // domain slug
  interviewType: string                     // depth slug
  seniorityBand: string                     // "0-2" | "3-6" | "7+" | "*"

  question: string
  category: string                          // e.g. "behavioral", "situational", "motivation"
  targetCompetencies: string[]
  difficulty: 'easy' | 'medium' | 'hard'

  // For answer exemplars
  idealAnswerPoints: string[]               // key points a good answer should cover
  commonMistakes: string[]

  // Metadata
  tags: string[]
  isActive: boolean
  usageCount: number                        // how many times this was used/retrieved

  createdAt: Date
  updatedAt: Date
}

const QuestionBankSchema = new Schema<IQuestionBank>(
  {
    domain: { type: String, required: true, index: true },
    interviewType: { type: String, required: true },
    seniorityBand: { type: String, default: '*' },

    question: { type: String, required: true },
    category: { type: String, required: true },
    targetCompetencies: [{ type: String }],
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },

    idealAnswerPoints: [{ type: String }],
    commonMistakes: [{ type: String }],

    tags: [{ type: String }],
    isActive: { type: Boolean, default: true },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

QuestionBankSchema.index({ domain: 1, interviewType: 1, difficulty: 1, isActive: 1 })
QuestionBankSchema.index({ targetCompetencies: 1 })
// Text index for semantic-like keyword search
QuestionBankSchema.index({ question: 'text', tags: 'text' })

export const QuestionBank: Model<IQuestionBank> =
  mongoose.models.QuestionBank ||
  mongoose.model<IQuestionBank>('QuestionBank', QuestionBankSchema)
