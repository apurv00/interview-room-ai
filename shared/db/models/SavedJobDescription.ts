import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ParsedRequirement {
  id: string
  category: 'technical' | 'behavioral' | 'experience' | 'education' | 'cultural'
  requirement: string
  importance: 'must-have' | 'nice-to-have'
  targetCompetencies: string[]
}

export interface IParsedJobDescription {
  rawText: string
  company: string
  role: string
  inferredDomain: string
  requirements: ParsedRequirement[]
  keyThemes: string[]
}

export interface ISavedJobDescription extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  name: string
  parsedJD: IParsedJobDescription
  createdAt: Date
  updatedAt: Date
}

const ParsedRequirementSchema = new Schema({
  id: { type: String, required: true },
  category: { type: String, enum: ['technical', 'behavioral', 'experience', 'education', 'cultural'], required: true },
  requirement: { type: String, required: true },
  importance: { type: String, enum: ['must-have', 'nice-to-have'], default: 'must-have' },
  targetCompetencies: [{ type: String }],
}, { _id: false })

const ParsedJobDescriptionSchema = new Schema({
  rawText: { type: String, required: true },
  company: { type: String, default: '' },
  role: { type: String, default: '' },
  inferredDomain: { type: String, default: '' },
  requirements: [ParsedRequirementSchema],
  keyThemes: [{ type: String }],
}, { _id: false })

const SavedJobDescriptionSchema = new Schema<ISavedJobDescription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    parsedJD: { type: ParsedJobDescriptionSchema, required: true },
  },
  { timestamps: true }
)

SavedJobDescriptionSchema.index({ userId: 1, createdAt: -1 })

export const SavedJobDescription: Model<ISavedJobDescription> =
  mongoose.models.SavedJobDescription ||
  mongoose.model<ISavedJobDescription>('SavedJobDescription', SavedJobDescriptionSchema)
