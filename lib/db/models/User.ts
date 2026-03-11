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
