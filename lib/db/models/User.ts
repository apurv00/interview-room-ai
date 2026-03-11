import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId
  email: string
  name: string
  image?: string
  emailVerified?: Date
  hashedPassword?: string

  role: 'candidate' | 'recruiter' | 'org_admin' | 'platform_admin'
  organizationId?: mongoose.Types.ObjectId

  targetRole?: 'PM' | 'SWE' | 'Sales' | 'MBA'
  experienceLevel?: '0-2' | '3-6' | '7+'

  // Onboarding profile
  onboardingCompleted: boolean
  currentTitle?: string
  currentIndustry?: 'tech' | 'finance' | 'consulting' | 'healthcare' | 'retail' | 'media' | 'government' | 'education' | 'startup' | 'other'
  isCareerSwitcher?: boolean
  switchingFrom?: string
  targetCompanyType?: 'faang' | 'startup' | 'midsize' | 'consulting' | 'enterprise' | 'any'
  interviewGoal?: 'first_interview' | 'improve_scores' | 'career_switch' | 'promotion' | 'general_practice'
  weakAreas?: string[]
  resumeText?: string
  resumeFileName?: string
  resumeR2Key?: string

  interviewCount: number
  lastInterviewAt?: Date

  plan: 'free' | 'pro' | 'enterprise'
  planExpiresAt?: Date
  stripeCustomerId?: string
  monthlyInterviewsUsed: number
  monthlyInterviewLimit: number
  usageResetAt?: Date

  createdAt: Date
  updatedAt: Date
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    image: { type: String },
    emailVerified: { type: Date },
    hashedPassword: { type: String },

    role: {
      type: String,
      enum: ['candidate', 'recruiter', 'org_admin', 'platform_admin'],
      default: 'candidate',
    },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    targetRole: { type: String, enum: ['PM', 'SWE', 'Sales', 'MBA'] },
    experienceLevel: { type: String, enum: ['0-2', '3-6', '7+'] },

    // Onboarding profile
    onboardingCompleted: { type: Boolean, default: false },
    currentTitle: { type: String, trim: true, maxlength: 100 },
    currentIndustry: { type: String, enum: ['tech', 'finance', 'consulting', 'healthcare', 'retail', 'media', 'government', 'education', 'startup', 'other'] },
    isCareerSwitcher: { type: Boolean, default: false },
    switchingFrom: { type: String, trim: true, maxlength: 100 },
    targetCompanyType: { type: String, enum: ['faang', 'startup', 'midsize', 'consulting', 'enterprise', 'any'] },
    interviewGoal: { type: String, enum: ['first_interview', 'improve_scores', 'career_switch', 'promotion', 'general_practice'] },
    weakAreas: [{ type: String, enum: ['star_structure', 'specificity', 'conciseness', 'confidence', 'technical_depth', 'storytelling'] }],
    resumeText: { type: String },
    resumeFileName: { type: String },
    resumeR2Key: { type: String },

    interviewCount: { type: Number, default: 0 },
    lastInterviewAt: { type: Date },

    plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
    planExpiresAt: { type: Date },
    stripeCustomerId: { type: String, sparse: true },
    monthlyInterviewsUsed: { type: Number, default: 0 },
    monthlyInterviewLimit: { type: Number, default: 999999 },
    usageResetAt: { type: Date },
  },
  { timestamps: true }
)

UserSchema.index({ email: 1 })
UserSchema.index({ organizationId: 1, role: 1 })
UserSchema.index({ stripeCustomerId: 1 }, { sparse: true })

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', UserSchema)
