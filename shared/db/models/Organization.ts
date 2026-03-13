import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IOrganization extends Document {
  _id: mongoose.Types.ObjectId
  name: string
  slug: string
  domain?: string

  logoUrl?: string
  primaryColor?: string

  plan: 'starter' | 'professional' | 'enterprise'
  maxSeats: number
  currentSeats: number
  monthlyInterviewLimit: number
  monthlyInterviewsUsed: number

  apiKeys: Array<{
    key: string
    keyPrefix: string
    name: string
    createdAt: Date
    lastUsedAt?: Date
    expiresAt?: Date
    isActive: boolean
  }>

  settings: {
    allowedRoles: string[]
    defaultDuration: number
    requireRecording: boolean
    customWelcomeMessage?: string
    webhookUrl?: string
  }

  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const OrganizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, index: true },
    domain: { type: String, lowercase: true, sparse: true, index: true },

    logoUrl: { type: String },
    primaryColor: { type: String },

    plan: {
      type: String,
      enum: ['starter', 'professional', 'enterprise'],
      default: 'starter',
    },
    maxSeats: { type: Number, default: 5 },
    currentSeats: { type: Number, default: 1 },
    monthlyInterviewLimit: { type: Number, default: 100 },
    monthlyInterviewsUsed: { type: Number, default: 0 },

    apiKeys: [
      {
        key: { type: String, required: true },
        keyPrefix: { type: String, required: true },
        name: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date },
        expiresAt: { type: Date },
        isActive: { type: Boolean, default: true },
      },
    ],

    settings: {
      allowedRoles: { type: [String], default: ['PM', 'SWE', 'Sales', 'MBA'] },
      defaultDuration: { type: Number, default: 10 },
      requireRecording: { type: Boolean, default: false },
      customWelcomeMessage: { type: String },
      webhookUrl: { type: String },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

export const Organization: Model<IOrganization> =
  mongoose.models.Organization ||
  mongoose.model<IOrganization>('Organization', OrganizationSchema)
