import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_CANDIDATE_SOURCES = [
  'manual',
  'apply_page',
  'bulk_upload',
] as const
export type HireCandidateSource = (typeof HIRE_CANDIDATE_SOURCES)[number]

/**
 * `pool` is a later recruiter action, never an original candidate source.
 * Keeping it separate prevents an old candidate card from being presented as
 * if it had originated in the talent pool itself.
 */
export const HIRE_CANDIDATE_PROVENANCE_SOURCES = [
  ...HIRE_CANDIDATE_SOURCES,
  'pool',
] as const
export type HireCandidateProvenanceSource =
  (typeof HIRE_CANDIDATE_PROVENANCE_SOURCES)[number]

export const HIRE_CANDIDATE_ANONYMIZATION_REASONS = [
  'retention',
  'privacy_request',
] as const
export type HireCandidateAnonymizationReason =
  (typeof HIRE_CANDIDATE_ANONYMIZATION_REASONS)[number]

/**
 * The last structured profile extracted from the candidate's current pool
 * resume. It is intentionally a bounded, Hire-only screening input rather
 * than a second copy of the document or a claim about a B2C account.
 */
export interface IHireCandidateScreeningProfile {
  location?: string
  experienceYears?: number
  /** Binds the profile to the exact current `resumeText` value. */
  resumeHash: string
  extractedAt: Date
}

/**
 * Workspace-level candidate (talent pool). Persists across jobs — the same
 * person applying to two jobs is one HireCandidate with two HireApplications
 * (build plan §Core data model). Email is the workspace-scoped identity used
 * for dedupe and for the guest OTP check on AI interview links.
 */
export interface IHireCandidate extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  name: string
  email: string
  phone?: string
  resumeText?: string
  resumeFileName?: string
  screeningProfile?: IHireCandidateScreeningProfile
  /**
   * Every Hire intake path ever associated with this workspace-local person.
   * `source` remains the original source for backward compatibility; this
   * bounded enum list records later manual/pool merges without manufacturing a
   * second candidate document.
   */
  sourceHistory?: HireCandidateProvenanceSource[]
  source: HireCandidateSource
  piiAnonymizedAt?: Date
  piiAnonymizationReason?: HireCandidateAnonymizationReason
  /** Monotonic transaction mutex shared by result/media finalization and
   * verified deletion. It contains no identity data. */
  privacyWriteFenceVersion: number
  anonymizationClaimToken?: string
  anonymizationLeaseExpiresAt?: Date
  anonymizationAttempts?: number
  anonymizationLastError?: string
  /** Legacy B2C actor pointer; absent for password-only Hire members. */
  createdBy?: mongoose.Types.ObjectId
  /** Authoritative Hire-owned creator for member-created candidates. */
  createdByMemberId?: mongoose.Types.ObjectId
  /** Immutable display snapshot; membership names may change later. */
  createdByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireCandidateSchema = new Schema<IHireCandidate>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    phone: { type: String, trim: true, maxlength: 32 },
    resumeText: { type: String, maxlength: 50000 },
    resumeFileName: { type: String, maxlength: 255 },
    screeningProfile: {
      type: new Schema<IHireCandidateScreeningProfile>(
        {
          location: { type: String, trim: true, maxlength: 160 },
          experienceYears: { type: Number, min: 0, max: 50 },
          resumeHash: {
            type: String,
            required: true,
            minlength: 64,
            maxlength: 64,
            match: /^[a-f0-9]{64}$/,
          },
          extractedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    source: { type: String, enum: HIRE_CANDIDATE_SOURCES, default: 'manual' },
    sourceHistory: {
      type: [{ type: String, enum: HIRE_CANDIDATE_PROVENANCE_SOURCES }],
      default: undefined,
    },
    piiAnonymizedAt: { type: Date },
    piiAnonymizationReason: {
      type: String,
      enum: HIRE_CANDIDATE_ANONYMIZATION_REASONS,
    },
    privacyWriteFenceVersion: { type: Number, default: 0, min: 0 },
    anonymizationClaimToken: { type: String, maxlength: 80 },
    anonymizationLeaseExpiresAt: { type: Date },
    anonymizationAttempts: { type: Number, default: 0, min: 0 },
    anonymizationLastError: { type: String, maxlength: 500 },
    // Legacy B2C actor pointer retained for historical records only. New
    // member writes are attributed to the Hire-owned member id/name below.
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
    createdByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      immutable: true,
    },
    createdByName: {
      type: String,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
  },
  { timestamps: true },
)

// Email dedupe within a workspace (Phase 2's "previously seen in [job]" flag
// builds on this same key). Cross-workspace duplicates are allowed by design —
// candidates are workspace-private.
HireCandidateSchema.index({ workspaceId: 1, email: 1 }, { unique: true })
HireCandidateSchema.index({
  workspaceId: 1,
  piiAnonymizedAt: 1,
  anonymizationLeaseExpiresAt: 1,
  updatedAt: 1,
})

export const HireCandidate: Model<IHireCandidate> =
  mongoose.models.HireCandidate ||
  mongoose.model<IHireCandidate>('HireCandidate', HireCandidateSchema)
