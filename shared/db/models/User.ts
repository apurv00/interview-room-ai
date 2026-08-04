import mongoose, {
  Schema,
  Document,
  Model,
  type SchemaDefinition,
} from 'mongoose'

export const SAVED_RESUME_STORAGE_MODES = [
  'embedded',
  'dual_embedded_primary',
  'dual_collection_primary',
  'collection_only',
] as const
export type SavedResumeStorageMode =
  (typeof SAVED_RESUME_STORAGE_MODES)[number]

export const SAVED_RESUME_MIGRATION_ISSUE_CODES = [
  'collection_fence_mismatch',
  'missing_collection_row',
  'unexpected_collection_row',
  'payload_hash_mismatch',
  'order_mismatch',
] as const
export type SavedResumeMigrationIssueCode =
  (typeof SAVED_RESUME_MIGRATION_ISSUE_CODES)[number]

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
  currentTitle?: string
  currentIndustry?: 'tech' | 'finance' | 'consulting' | 'healthcare' | 'retail' | 'media' | 'government' | 'education' | 'startup' | 'other'
  targetCompanyType?: 'faang' | 'startup' | 'midsize' | 'consulting' | 'enterprise' | 'any'
  interviewGoal?: 'first_interview' | 'improve_scores' | 'career_switch' | 'promotion' | 'general_practice'
  weakAreas?: string[]
  resumeText?: string
  resumeFileName?: string
  resumeR2Key?: string

  // Extended profile for personalization
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
    // True only when atsScore came from a real ATS check. Legacy rows stored
    // the tailor's JD match-score here (a different metric); gating the badge
    // on this flag stops the dashboard showing those as "ATS: N".
    atsScoreFromCheck?: boolean

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

    /** Drag-reordered section sequence — empty/absent = template default. */
    sectionOrder?: string[]
    styling?: {
      fontFamily?: string
      fontSize?: string
      headingSize?: number
      bodySize?: number
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
    /** Jobs email wave (EMAILS.md §3). Coarse toggles for the settings UI;
     *  unsubscribedStreams is what unsubscribe links write — closed enum
     *  e0..e4 plus the explicit 'all' marker (never a fan-out). Absent
     *  fields mean default-true: send queries filter with { $ne: false }. */
    jobs?: {
      nudges: boolean
      digest: boolean
      unsubscribedStreams: string[]
    }
  }

  interviewCount: number
  lastInterviewAt?: Date

  plan: 'free' | 'pro' | 'enterprise'
  planExpiresAt?: Date
  stripeCustomerId?: string
  monthlyInterviewsUsed: number
  monthlyInterviewLimit: number
  usageResetAt?: Date

  /** A deletion request flips this before any personal-data sweep. Missing
   *  means active for legacy and raw MongoDBAdapter-created rows. */
  accountState?: 'active' | 'deleting'
  accountDeletionRequestedAt?: Date
  /** Shared Mongo write-conflict seam for user-owned Jobs data. */
  jobsWriteRevision?: number

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
    currentTitle: { type: String, trim: true, maxlength: 100 },
    currentIndustry: { type: String, enum: ['tech', 'finance', 'consulting', 'healthcare', 'retail', 'media', 'government', 'education', 'startup', 'other'] },
    targetCompanyType: { type: String, enum: ['faang', 'startup', 'midsize', 'consulting', 'enterprise', 'any'] },
    interviewGoal: { type: String, enum: ['first_interview', 'improve_scores', 'career_switch', 'promotion', 'general_practice'] },
    weakAreas: [{ type: String, enum: ['star_structure', 'specificity', 'conciseness', 'confidence', 'technical_depth', 'storytelling'] }],
    resumeText: { type: String },
    resumeFileName: { type: String },
    resumeR2Key: { type: String },

    // Extended profile for personalization
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
      atsScoreFromCheck: { type: Boolean, default: false },

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

      // sectionOrder + heading/body sizes: the editor supports these and the
      // save validator accepts them, but the subschema silently stripped them
      // (Mongoose strict mode) — "Saved!" showed, layout reverted on reload.
      sectionOrder: [{ type: String }],
      styling: {
        fontFamily: { type: String },
        fontSize: { type: String },
        headingSize: { type: Number },
        bodySize: { type: Number },
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
      jobs: {
        nudges: { type: Boolean, default: true },
        digest: { type: Boolean, default: true },
        unsubscribedStreams: { type: [{ type: String, enum: ['e0', 'e1', 'e2', 'e3', 'e4', 'all'] }], default: [] },
      },
    },

    interviewCount: { type: Number, default: 0 },
    lastInterviewAt: { type: Date },

    plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
    planExpiresAt: { type: Date },
    stripeCustomerId: { type: String, sparse: true },
    monthlyInterviewsUsed: { type: Number, default: 0 },
    monthlyInterviewLimit: { type: Number, default: 999999 },
    usageResetAt: { type: Date },

    accountState: { type: String, enum: ['active', 'deleting'], default: 'active' },
    accountDeletionRequestedAt: { type: Date },
    jobsWriteRevision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
)

// Billing v2 is intentionally attached as a narrow schema projection instead
// of widening IUser. IUser is imported across the application, while these
// fields are owned and typed by the payment services that read/write them.
const BillingUserProjectionDefinition: SchemaDefinition = {
  savedResumeStorageMode: {
    type: String,
    enum: SAVED_RESUME_STORAGE_MODES,
    default: 'embedded',
  },
  savedResumeLibraryVersion: { type: Number, min: 0, default: 0 },
  savedResumeCollectionCount: { type: Number, min: 0, default: 0 },
  savedResumeMigration: {
    sourceHash: { type: String, match: /^[a-f0-9]{64}$/ },
    rowCount: { type: Number, min: 0 },
    storageVersion: { type: Number, min: 0 },
    verifiedVersion: { type: Number, min: 0 },
    verifiedAt: { type: Date },
    collectionActivatedAt: { type: Date },
    embeddedContractedAt: { type: Date },
    issueCodes: [{
      type: String,
      enum: SAVED_RESUME_MIGRATION_ISSUE_CODES,
    }],
  },
  planVocabularyVersion: { type: Number, enum: [1, 2] },
  legacyMonthlyInterviewResetAt: { type: Date },
  entitlementSource: {
    type: String,
    enum: ['free', 'subscription', 'admin_grant'],
  },
  usagePeriodKey: { type: String },
  interviewsUsed: { type: Number, min: 0 },
  interviewLimit: { type: Number, min: 0 },
  premiumResumesUsed: { type: Number, min: 0 },
  premiumResumeLimit: { type: Number, min: 0 },
  freeBasicResumeId: { type: String },
  entitlementVersion: { type: Number, min: 0 },
  buyerState: { type: String, trim: true, maxlength: 100 },
  personalDataWriteVersion: { type: Number, min: 0, default: 0 },
  externalDataWriteDrainUntil: { type: Date },
  razorpayCustomerId: { type: String, sparse: true },
}

UserSchema.add(BillingUserProjectionDefinition)
const storedPlanPath = UserSchema.path('plan')
if (storedPlanPath instanceof Schema.Types.String) {
  storedPlanPath.enum('plus')
}

UserSchema.index({ organizationId: 1, role: 1 })
UserSchema.index({ stripeCustomerId: 1 }, { sparse: true })
UserSchema.index({ razorpayCustomerId: 1 }, { unique: true, sparse: true })

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', UserSchema)
