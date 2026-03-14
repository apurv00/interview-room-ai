import mongoose, { Schema, Document, Model, Types } from 'mongoose'

// ─── Types ─────────────────────────────────────────────────────────────────

export type WizardSegment = 'fresh_grad' | 'career_changer' | 'returning_worker' | 'experienced'
export type WizardStatus = 'in_progress' | 'completed' | 'abandoned'
export type BulletDecision = 'accept' | 'reject' | 'edit'

export interface IFollowUpQA {
  question: string
  answer: string
}

export interface IBulletDecisionEntry {
  index: number
  decision: BulletDecision
  editedText?: string
}

export interface IWizardRole {
  id: string
  company: string
  title: string
  location?: string
  startDate: string
  endDate?: string
  rawBullets: string[]
  followUpQuestions: IFollowUpQA[]
  enhancedBullets: string[]
  bulletDecisions: IBulletDecisionEntry[]
  finalBullets: string[]
}

export interface IWizardEducation {
  id: string
  institution: string
  degree: string
  field?: string
  graduationDate?: string
  gpa?: string
  honors?: string
}

export interface IWizardSkills {
  hard: string[]
  soft: string[]
  technical: string[]
}

export interface IWizardProject {
  id: string
  name: string
  description: string
  technologies?: string[]
  url?: string
}

export interface IWizardCertification {
  name: string
  issuer: string
  date?: string
}

export interface IWizardContactInfo {
  fullName: string
  email: string
  phone?: string
  city?: string
  linkedInUrl?: string
}

export interface IStrengthBreakdown {
  contact: number
  experience: number
  education: number
  skills: number
  extras: number
}

export interface IWizardSession extends Document {
  userId: Types.ObjectId
  status: WizardStatus
  segment: WizardSegment | null
  currentStage: number
  contactInfo: IWizardContactInfo | null
  roles: IWizardRole[]
  education: IWizardEducation[]
  skills: IWizardSkills
  projects: IWizardProject[]
  certifications: IWizardCertification[]
  generatedSummary: string
  finalSummary: string
  strengthScore: number
  strengthBreakdown: IStrengthBreakdown
  aiCostUsd: number
  aiCallCount: number
  selectedTemplate: string
  exportedResumeId: string | null
  createdAt: Date
  updatedAt: Date
}

// ─── Schema ────────────────────────────────────────────────────────────────

const FollowUpQASchema = new Schema({
  question: { type: String, required: true },
  answer: { type: String, default: '' },
}, { _id: false })

const BulletDecisionSchema = new Schema({
  index: { type: Number, required: true },
  decision: { type: String, enum: ['accept', 'reject', 'edit'], required: true },
  editedText: { type: String },
}, { _id: false })

const WizardRoleSchema = new Schema({
  id: { type: String, required: true },
  company: { type: String, default: '' },
  title: { type: String, default: '' },
  location: { type: String },
  startDate: { type: String, default: '' },
  endDate: { type: String },
  rawBullets: [{ type: String }],
  followUpQuestions: [FollowUpQASchema],
  enhancedBullets: [{ type: String }],
  bulletDecisions: [BulletDecisionSchema],
  finalBullets: [{ type: String }],
}, { _id: false })

const WizardEducationSchema = new Schema({
  id: { type: String, required: true },
  institution: { type: String, default: '' },
  degree: { type: String, default: '' },
  field: { type: String },
  graduationDate: { type: String },
  gpa: { type: String },
  honors: { type: String },
}, { _id: false })

const WizardProjectSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, default: '' },
  description: { type: String, default: '' },
  technologies: [{ type: String }],
  url: { type: String },
}, { _id: false })

const WizardCertificationSchema = new Schema({
  name: { type: String, default: '' },
  issuer: { type: String, default: '' },
  date: { type: String },
}, { _id: false })

const WizardSessionSchema = new Schema<IWizardSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['in_progress', 'completed', 'abandoned'], default: 'in_progress' },
    segment: { type: String, enum: ['fresh_grad', 'career_changer', 'returning_worker', 'experienced', null], default: null },
    currentStage: { type: Number, min: 0, max: 7, default: 0 },

    contactInfo: {
      type: new Schema({
        fullName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String },
        city: { type: String },
        linkedInUrl: { type: String },
      }, { _id: false }),
      default: null,
    },

    roles: { type: [WizardRoleSchema], default: [] },
    education: { type: [WizardEducationSchema], default: [] },

    skills: {
      type: new Schema({
        hard: [{ type: String }],
        soft: [{ type: String }],
        technical: [{ type: String }],
      }, { _id: false }),
      default: { hard: [], soft: [], technical: [] },
    },

    projects: { type: [WizardProjectSchema], default: [] },
    certifications: { type: [WizardCertificationSchema], default: [] },

    generatedSummary: { type: String, default: '' },
    finalSummary: { type: String, default: '' },

    strengthScore: { type: Number, min: 0, max: 100, default: 0 },
    strengthBreakdown: {
      type: new Schema({
        contact: { type: Number, default: 0 },
        experience: { type: Number, default: 0 },
        education: { type: Number, default: 0 },
        skills: { type: Number, default: 0 },
        extras: { type: Number, default: 0 },
      }, { _id: false }),
      default: { contact: 0, experience: 0, education: 0, skills: 0, extras: 0 },
    },

    aiCostUsd: { type: Number, default: 0 },
    aiCallCount: { type: Number, default: 0 },

    selectedTemplate: { type: String, default: 'professional' },
    exportedResumeId: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'wizardSessions',
  }
)

// ─── Indexes ───────────────────────────────────────────────────────────────

WizardSessionSchema.index({ userId: 1, status: 1 })
WizardSessionSchema.index({ userId: 1, createdAt: -1 })

// ─── Model ─────────────────────────────────────────────────────────────────

export const WizardSession: Model<IWizardSession> =
  mongoose.models.WizardSession || mongoose.model<IWizardSession>('WizardSession', WizardSessionSchema)
