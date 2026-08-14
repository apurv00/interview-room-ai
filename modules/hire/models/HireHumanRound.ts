import mongoose, { Document, Model, Schema } from 'mongoose'

/**
 * Human interviews deliberately live outside `HireRound`: that collection is
 * the control-plane side of an engine session and has AI-only token, consent,
 * runtime, and result invariants. A human call is evidence recorded by Hire
 * only; neither creation nor revocation ever calls the interview engine.
 */
export const HIRE_HUMAN_ROUND_MODES = ['guest_kit', 'member_room'] as const
export type HireHumanRoundMode = (typeof HIRE_HUMAN_ROUND_MODES)[number]

export const HIRE_HUMAN_ROUND_STATUSES = [
  'pending_scorecard',
  'completed',
  'revoked',
] as const
export type HireHumanRoundStatus = (typeof HIRE_HUMAN_ROUND_STATUSES)[number]

export interface IHireHumanRoundBrief {
  /** Deliberately bounded minimum-disclosure data for an external interviewer. */
  candidateName: string
  jobTitle: string
  location?: string
  experienceYears?: number
  /** Hash only; never a full resume or candidate contact detail. */
  sourceResumeHash?: string
}

export interface IHireHumanRound extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  mode: HireHumanRoundMode
  status: HireHumanRoundStatus
  /** Workspace-scoped idempotency coordinate for a member POST. */
  creationOperationId: string
  briefSnapshot: IHireHumanRoundBrief
  createdByMemberId: mongoose.Types.ObjectId
  createdByName: string
  openedAt?: Date
  scorecardSubmittedAt?: Date
  revokedAt?: Date
  revokedByMemberId?: mongoose.Types.ObjectId
  revokedByName?: string
  revocationReason?: string
  /** Set during candidate deletion/retention cleanup. */
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HumanRoundBriefSchema = new Schema<IHireHumanRoundBrief>(
  {
    candidateName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    jobTitle: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
    location: { type: String, trim: true, maxlength: 160, immutable: true },
    experienceYears: { type: Number, min: 0, max: 50, immutable: true },
    sourceResumeHash: { type: String, match: /^[a-f0-9]{64}$/i, immutable: true },
  },
  { _id: false },
)

const HireHumanRoundSchema = new Schema<IHireHumanRound>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    mode: { type: String, enum: HIRE_HUMAN_ROUND_MODES, required: true, immutable: true },
    status: { type: String, enum: HIRE_HUMAN_ROUND_STATUSES, default: 'pending_scorecard' },
    creationOperationId: { type: String, required: true, maxlength: 80, immutable: true },
    briefSnapshot: { type: HumanRoundBriefSchema, required: true, immutable: true },
    createdByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember', required: true, immutable: true },
    createdByName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    openedAt: { type: Date },
    scorecardSubmittedAt: { type: Date },
    revokedAt: { type: Date },
    revokedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    revokedByName: { type: String, trim: true, maxlength: 120 },
    revocationReason: { type: String, trim: true, maxlength: 1000 },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true },
)

HireHumanRoundSchema.index({ workspaceId: 1, applicationId: 1, createdAt: -1 })
HireHumanRoundSchema.index({ workspaceId: 1, jobId: 1, status: 1, createdAt: -1 })
HireHumanRoundSchema.index({ workspaceId: 1, creationOperationId: 1 }, { unique: true })

export const HireHumanRound: Model<IHireHumanRound> =
  mongoose.models.HireHumanRound ||
  mongoose.model<IHireHumanRound>('HireHumanRound', HireHumanRoundSchema)
