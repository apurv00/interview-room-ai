import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IInterviewSkill extends Document {
  _id: mongoose.Types.ObjectId
  domain: string
  depth: string
  content: string           // full markdown content
  isActive: boolean
  lastEditedBy?: mongoose.Types.ObjectId
  lastEditedAt?: Date
  version: number
  createdAt: Date
  updatedAt: Date
}

const InterviewSkillSchema = new Schema<IInterviewSkill>(
  {
    domain: { type: String, required: true, lowercase: true, trim: true },
    depth: { type: String, required: true, lowercase: true, trim: true },
    content: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    lastEditedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastEditedAt: { type: Date },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
)

InterviewSkillSchema.index({ domain: 1, depth: 1 }, { unique: true })
InterviewSkillSchema.index({ isActive: 1 })

export const InterviewSkill: Model<IInterviewSkill> =
  mongoose.models.InterviewSkill ||
  mongoose.model<IInterviewSkill>('InterviewSkill', InterviewSkillSchema)
