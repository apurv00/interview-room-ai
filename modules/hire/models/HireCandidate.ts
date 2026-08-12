import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_CANDIDATE_SOURCES = [
  'manual',
  'apply_page',
  'bulk_upload',
] as const
export type HireCandidateSource = (typeof HIRE_CANDIDATE_SOURCES)[number]

export const HIRE_CANDIDATE_ANONYMIZATION_REASONS = [
  'retention',
  'privacy_request',
] as const
export type HireCandidateAnonymizationReason =
  (typeof HIRE_CANDIDATE_ANONYMIZATION_REASONS)[number]

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
    source: { type: String, enum: HIRE_CANDIDATE_SOURCES, default: 'manual' },
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
