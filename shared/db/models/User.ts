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

  targetRole?: string
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

  // Extended profile for personalization
  preferredDomains?: string[]          // domains user practices most / wants to focus on
  preferredInterviewTypes?: string[]   // interview types user prefers
  targetCompanies?: string[]           // specific company names
  linkedinUrl?: string
  yearsInCurrentRole?: number
  educationLevel?: 'high_school' | 'bachelors' | 'masters' | 'phd' | 'bootcamp' | 'self_taught'
  topSkills?: string[]                 // up to 10 key skills
  communicationStyle?: 'concise' | 'detailed' | 'storyteller'
  feedbackPreference?: 'encouraging' | 'balanced' | 'tough_love'
  timezone?: string
  languagePreference?: string

  // Practice tracking per domain+type combination
  practiceStats?: Map<string, {        // key: "domain:interviewType"
    totalSessions: number
    avgScore: number
    lastScore: number
    lastPracticedAt: Date
    strongDimensions: string[]
    weakDimensions: string[]
  }>

  // Saved resumes (structured)
  savedResumes?: Array<{
    id: string
    name: string
    template: string
    targetRole?: string
    targetCompany?: string
    atsScore?: number | null

    contactInfo: {
      fullName: string
      email: string
      phone?: string
      location?: string
      linkedin?: string
      website?: string
      github?: string
    }
    summary: string
    experience: Array<{
      id: string
      company: string
      title: string
      location?: string
      startDate: string
      endDate?: string
      bullets: string[]
    }>
    education: Array<{
      id: string
      institution: string
      degree: string
      field?: string
      graduationDate?: string
      gpa?: string
      honors?: string
    }>
    skills: Array<{
      category: string
      items: string[]
    }>
    projects: Array<{
      id: string
      name: string
      description: string
      technologies?: string[]
      url?: string
    }>
    certifications: Array<{
      name: string
      issuer: string
      date?: string
    }>
    customSections: Array<{
      id: string
      title: string
      content: string
    }>

    styling?: {
      fontFamily?: string
      fontSize?: string
    }

    // Legacy field for backward compatibility + ATS/tailor operations
    sections?: Record<string, string>
    fullText?: string
    createdAt: string
    updatedAt: string
  }>

  // STAR Stories
  starStories?: Array<{
    id: string
    resumeId: string
    experienceId: string
    originalBullet: string
    situation: string
    task: string
    action: string
    result: string
    targetQuestion: string
    skills: string[]
    createdAt: string
  }>

  // Privacy & Consent
  privacyConsent?: {
    recordingConsent: boolean
    recordingConsentAt?: Date
    analysisConsent: boolean
    analysisConsentAt?: Date
    marketingOptIn: boolean
    /**
     * Research donation consent — when true, the user has opted in to have
     * their multimodal signals run through the dual-pipeline comparison
     * experiment (baseline facial label vs. blendshape-enriched fusion).
     * Scoped to the paper's evaluation only. Never affects the user-facing
     * analysis, which always runs the enhanced variant.
     */
    researchDonationConsent?: boolean
    researchDonationConsentAt?: Date
  }

  // XP & Levels
  xp: number
  level: number
  xpThisWeek: number
  weeklyXpResetAt?: Date

  // Streak tracking
  currentStreak: number
  longestStreak: number
  lastSessionDate?: Date
  streakFreezeAvailable: number
  streakFreezeUsedAt?: Date
  streakFreezeResetAt?: Date

  // Email preferences
  emailPreferences?: {
    digest: boolean
    reminders: boolean
    frequency: 'daily' | 'weekly'
  }

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

    targetRole: { type: String },
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

    // Extended profile for personalization
    preferredDomains: [{ type: String }],
    preferredInterviewTypes: [{ type: String }],
    targetCompanies: [{ type: String }],
    linkedinUrl: { type: String, trim: true },
    yearsInCurrentRole: { type: Number, min: 0, max: 50 },
    educationLevel: { type: String, enum: ['high_school', 'bachelors', 'masters', 'phd', 'bootcamp', 'self_taught'] },
    topSkills: [{ type: String, trim: true, maxlength: 50 }],
    communicationStyle: { type: String, enum: ['concise', 'detailed', 'storyteller'] },
    feedbackPreference: { type: String, enum: ['encouraging', 'balanced', 'tough_love'] },
    timezone: { type: String },
    languagePreference: { type: String, default: 'en' },

    // Practice tracking per domain+type combination
    practiceStats: { type: Map, of: {
      totalSessions: { type: Number, default: 0 },
      avgScore: { type: Number, default: 0 },
      lastScore: { type: Number, default: 0 },
      lastPracticedAt: { type: Date },
      strongDimensions: [{ type: String }],
      weakDimensions: [{ type: String }],
    }},

    // Saved resumes (structured)
    savedResumes: [{
      id: { type: String, required: true },
      name: { type: String, required: true },
      template: { type: String, default: 'professional' },
      targetRole: { type: String, default: '' },
      targetCompany: { type: String, default: '' },
      atsScore: { type: Number, default: null },

      contactInfo: {
        fullName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String },
        location: { type: String },
        linkedin: { type: String },
        website: { type: String },
        github: { type: String },
      },
      summary: { type: String, default: '' },
      experience: [{
        id: { type: String, required: true },
        company: { type: String, required: true },
        title: { type: String, required: true },
        location: { type: String },
        startDate: { type: String, required: true },
        endDate: { type: String },
        bullets: [{ type: String }],
      }],
      education: [{
        id: { type: String, required: true },
        institution: { type: String, required: true },
        degree: { type: String, required: true },
        field: { type: String },
        graduationDate: { type: String },
        gpa: { type: String },
        honors: { type: String },
      }],
      skills: [{
        category: { type: String, required: true },
        items: [{ type: String }],
      }],
      projects: [{
        id: { type: String, required: true },
        name: { type: String, required: true },
        description: { type: String, required: true },
        technologies: [{ type: String }],
        url: { type: String },
      }],
      certifications: [{
        name: { type: String, required: true },
        issuer: { type: String, required: true },
        date: { type: String },
      }],
      customSections: [{
        id: { type: String, required: true },
        title: { type: String, required: true },
        content: { type: String, required: true },
      }],

      styling: {
        fontFamily: { type: String },
        fontSize: { type: String },
      },

      // Legacy + utility fields
      sections: { type: Schema.Types.Mixed, default: {} },
      fullText: { type: String, default: '' },
      createdAt: { type: String },
      updatedAt: { type: String },
    }],

    // XP & Levels
    // STAR Stories
    starStories: [{
      id: { type: String, required: true },
      resumeId: { type: String, required: true },
      experienceId: { type: String },
      originalBullet: { type: String },
      situation: { type: String, required: true },
      task: { type: String, required: true },
      action: { type: String, required: true },
      result: { type: String, required: true },
      targetQuestion: { type: String },
      skills: [{ type: String }],
      createdAt: { type: String, default: () => new Date().toISOString() },
    }],

    // Privacy & Consent
    privacyConsent: {
      recordingConsent: { type: Boolean, default: false },
      recordingConsentAt: { type: Date },
      analysisConsent: { type: Boolean, default: false },
      analysisConsentAt: { type: Date },
      marketingOptIn: { type: Boolean, default: false },
      // Research donation consent — scoped to the dual-pipeline comparison
      // experiment only. Safe to leave undefined; defaults to opted out.
      researchDonationConsent: { type: Boolean, default: false },
      researchDonationConsentAt: { type: Date },
    },

    xp: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    xpThisWeek: { type: Number, default: 0 },
    weeklyXpResetAt: { type: Date },

    // Streak tracking
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastSessionDate: { type: Date },
    streakFreezeAvailable: { type: Number, default: 0 },
    streakFreezeUsedAt: { type: Date },
    streakFreezeResetAt: { type: Date },

    // Email preferences
    emailPreferences: {
      digest: { type: Boolean, default: true },
      reminders: { type: Boolean, default: true },
      frequency: { type: String, enum: ['daily', 'weekly'], default: 'weekly' },
    },

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
