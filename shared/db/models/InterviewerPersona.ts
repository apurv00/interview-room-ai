import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IInterviewerPersona extends Document {
  _id: mongoose.Types.ObjectId
  slug: string
  name: string
  title: string
  companyArchetype: string
  avatarVariant: string
  communicationStyle: {
    warmth: number
    pace: number
    probingDepth: number
    formality: number
  }
  systemPromptFragment: string
  preferredEmotions: string[]
  ttsConfig: {
    rate: number
    pitch: number
  }
  isDefault: boolean
  isActive: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

const InterviewerPersonaSchema = new Schema<IInterviewerPersona>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    title: { type: String, required: true },
    companyArchetype: { type: String, default: 'general' },
    avatarVariant: { type: String, default: 'default' },
    communicationStyle: {
      warmth: { type: Number, default: 0.5, min: 0, max: 1 },
      pace: { type: Number, default: 0.5, min: 0, max: 1 },
      probingDepth: { type: Number, default: 0.5, min: 0, max: 1 },
      formality: { type: Number, default: 0.5, min: 0, max: 1 },
    },
    systemPromptFragment: { type: String, default: '' },
    preferredEmotions: [{ type: String }],
    ttsConfig: {
      rate: { type: Number, default: 1.08 },
      pitch: { type: Number, default: 1.0 },
    },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
)

InterviewerPersonaSchema.index({ isActive: 1, sortOrder: 1 })

export const InterviewerPersona: Model<IInterviewerPersona> =
  mongoose.models.InterviewerPersona ||
  mongoose.model<IInterviewerPersona>('InterviewerPersona', InterviewerPersonaSchema)
