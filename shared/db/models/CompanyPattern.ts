import mongoose, { Schema, Document, Model } from 'mongoose'

export interface ICompanyPattern extends Document {
  _id: mongoose.Types.ObjectId
  companyName: string                       // normalized company name
  companyType: 'faang' | 'startup' | 'midsize' | 'consulting' | 'enterprise' | 'other'

  // Interview patterns
  interviewStyle: string                    // e.g. "structured behavioral with leadership principles"
  commonRounds: string[]                    // e.g. ["phone_screen", "behavioral", "bar_raiser"]
  culturalValues: string[]                  // e.g. ["customer_obsession", "ownership", "bias_for_action"]
  knownQuestionPatterns: string[]
  interviewTips: string[]

  // Domains this applies to
  applicableDomains: string[]               // empty = all

  // What they evaluate heavily
  evaluationFocus: string[]                 // competencies they weight

  isActive: boolean

  createdAt: Date
  updatedAt: Date
}

const CompanyPatternSchema = new Schema<ICompanyPattern>(
  {
    companyName: { type: String, required: true, lowercase: true, trim: true },
    companyType: {
      type: String,
      enum: ['faang', 'startup', 'midsize', 'consulting', 'enterprise', 'other'],
      default: 'other',
    },

    interviewStyle: { type: String, default: '' },
    commonRounds: [{ type: String }],
    culturalValues: [{ type: String }],
    knownQuestionPatterns: [{ type: String }],
    interviewTips: [{ type: String }],

    applicableDomains: [{ type: String }],
    evaluationFocus: [{ type: String }],

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

CompanyPatternSchema.index({ companyName: 1 }, { unique: true })
CompanyPatternSchema.index({ companyType: 1, isActive: 1 })
CompanyPatternSchema.index({ companyName: 'text' })

export const CompanyPattern: Model<ICompanyPattern> =
  mongoose.models.CompanyPattern ||
  mongoose.model<ICompanyPattern>('CompanyPattern', CompanyPatternSchema)
