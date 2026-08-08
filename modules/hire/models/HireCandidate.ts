import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_CANDIDATE_SOURCES = ['manual', 'apply_page', 'bulk_upload'] as const
export type HireCandidateSource = (typeof HIRE_CANDIDATE_SOURCES)[number]

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
  createdBy: mongoose.Types.ObjectId
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
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 32 },
    resumeText: { type: String, maxlength: 50000 },
    resumeFileName: { type: String, maxlength: 255 },
    source: { type: String, enum: HIRE_CANDIDATE_SOURCES, default: 'manual' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

// Email dedupe within a workspace (Phase 2's "previously seen in [job]" flag
// builds on this same key). Cross-workspace duplicates are allowed by design —
// candidates are workspace-private.
HireCandidateSchema.index({ workspaceId: 1, email: 1 }, { unique: true })

export const HireCandidate: Model<IHireCandidate> =
  mongoose.models.HireCandidate ||
  mongoose.model<IHireCandidate>('HireCandidate', HireCandidateSchema)
