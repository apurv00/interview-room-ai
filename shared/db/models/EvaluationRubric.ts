import mongoose, { Schema, Document, Model } from 'mongoose'

export interface RubricDimension {
  name: string
  label: string
  weight: number            // 0-1
  description: string
  scoringGuide: {
    excellent: string       // 80-100
    good: string            // 60-79
    adequate: string        // 40-59
    weak: string            // 0-39
  }
}

export interface IEvaluationRubric extends Document {
  _id: mongoose.Types.ObjectId
  rubricId: string                           // e.g. "rubric_pm_hm_v3"
  domain: string                             // domain slug or "*" for universal
  interviewType: string                      // depth slug or "*" for universal
  seniorityBand: string                      // "0-2" | "3-6" | "7+" | "*"
  version: number
  isActive: boolean

  dimensions: RubricDimension[]

  // Scoring thresholds
  passThreshold: number                      // score needed for "pass" recommendation
  strongPassThreshold: number                // score needed for "strong pass"

  // Domain-specific competencies this rubric evaluates
  competencies: string[]

  createdAt: Date
  updatedAt: Date
}

const RubricDimensionSchema = new Schema({
  name: { type: String, required: true },
  label: { type: String, required: true },
  weight: { type: Number, required: true, min: 0, max: 1 },
  description: { type: String, default: '' },
  scoringGuide: {
    excellent: { type: String, default: '' },
    good: { type: String, default: '' },
    adequate: { type: String, default: '' },
    weak: { type: String, default: '' },
  },
}, { _id: false })

const EvaluationRubricSchema = new Schema<IEvaluationRubric>(
  {
    rubricId: { type: String, required: true, unique: true },
    domain: { type: String, required: true, default: '*' },
    interviewType: { type: String, required: true, default: '*' },
    seniorityBand: { type: String, required: true, default: '*' },
    version: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },

    dimensions: [RubricDimensionSchema],

    passThreshold: { type: Number, default: 60 },
    strongPassThreshold: { type: Number, default: 80 },

    competencies: [{ type: String }],
  },
  { timestamps: true }
)

EvaluationRubricSchema.index({ domain: 1, interviewType: 1, seniorityBand: 1, isActive: 1 })
EvaluationRubricSchema.index({ rubricId: 1 })

export const EvaluationRubric: Model<IEvaluationRubric> =
  mongoose.models.EvaluationRubric ||
  mongoose.model<IEvaluationRubric>('EvaluationRubric', EvaluationRubricSchema)
