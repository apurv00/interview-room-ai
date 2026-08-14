import mongoose, { Document, Model, Schema } from 'mongoose'

/** Hash-only, application-scoped possession capability for one interviewer. */
export const HIRE_INTERVIEW_KIT_STATUSES = ['active', 'submitted', 'revoked'] as const
export type HireInterviewKitStatus = (typeof HIRE_INTERVIEW_KIT_STATUSES)[number]

export interface IHireInterviewKit extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  humanRoundId: mongoose.Types.ObjectId
  /** sha256 of a 32-byte random secret. The raw secret is never persisted. */
  secretHash: string
  expiresAt: Date
  status: HireInterviewKitStatus
  /** Drives the partial one-active-kit-per-round uniqueness fence. */
  active: boolean
  openedAt?: Date
  submittedAt?: Date
  revokedAt?: Date
  revokedByMemberId?: mongoose.Types.ObjectId
  revokedByName?: string
  revocationReason?: string
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireInterviewKitSchema = new Schema<IHireInterviewKit>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    humanRoundId: { type: Schema.Types.ObjectId, ref: 'HireHumanRound', required: true, immutable: true },
    secretHash: { type: String, required: true, match: /^[a-f0-9]{64}$/i, immutable: true, select: false },
    expiresAt: { type: Date, required: true, immutable: true },
    status: { type: String, enum: HIRE_INTERVIEW_KIT_STATUSES, default: 'active' },
    active: { type: Boolean, default: true },
    openedAt: { type: Date },
    submittedAt: { type: Date },
    revokedAt: { type: Date },
    revokedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    revokedByName: { type: String, trim: true, maxlength: 120 },
    revocationReason: { type: String, trim: true, maxlength: 1000 },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true },
)

HireInterviewKitSchema.index({ workspaceId: 1, _id: 1, secretHash: 1 })
HireInterviewKitSchema.index(
  { workspaceId: 1, humanRoundId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
)
HireInterviewKitSchema.index({ workspaceId: 1, applicationId: 1, status: 1 })

export const HireInterviewKit: Model<IHireInterviewKit> =
  mongoose.models.HireInterviewKit ||
  mongoose.model<IHireInterviewKit>('HireInterviewKit', HireInterviewKitSchema)
