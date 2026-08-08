import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_ROUND_KINDS = ['ai'] as const // 'human' arrives in Phase 3
export type HireRoundKind = (typeof HIRE_ROUND_KINDS)[number]

/**
 * Round lifecycle. 'expired' is deliberately NOT a stored status — expiry is
 * a property of the token (inviteTokenExpiry checked in queries), so a round
 * never silently flips state without a witnessed action (build plan §Principles
 * "no silent failures"). 'revoked' is terminal.
 */
export const HIRE_ROUND_STATUSES = [
  'invited',
  'consented',
  'auth_verified',
  'prepared',
  'completed',
  'revoked',
] as const
export type HireRoundStatus = (typeof HIRE_ROUND_STATUSES)[number]

/**
 * Results snapshot copied from the candidate's InterviewSession at link time.
 * This is the build plan's "engine writes results keyed to application/round
 * IDs" made concrete: the hire module READS the engine's session once and
 * keys the snapshot to the round — hire never writes into engine tables.
 */
export interface HireRoundPerQuestion {
  questionIndex: number
  question: string
  answer?: string
  answerSummary?: string
  score: number | null
  relevance?: number | null
  structure?: number | null
  specificity?: number | null
  ownership?: number | null
  jdAlignment?: number | null
  flags?: string[]
}

export interface HireRoundResults {
  overallScore: number | null
  passProbability?: string
  confidenceLevel?: string
  answerQualityScore?: number | null
  communicationScore?: number | null
  jdMatchScore?: number | null
  redFlags?: string[]
  topImprovements?: string[]
  answeredCount?: number | null
  plannedQuestionCount?: number | null
  endReason?: string | null
  perQuestion?: HireRoundPerQuestion[]
  /** True when the session completed but session-level feedback isn't
   * generated yet — the snapshot is refreshed on later reads. */
  pending?: boolean
  sessionCompletedAt?: Date
}

export interface IHireRound extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  /** Denormalized from HireCandidate at send time — the OTP identity check. */
  candidateEmail: string
  candidateName?: string
  kind: HireRoundKind
  status: HireRoundStatus
  /** sha256 of the emailed 32-byte token; the raw token is never stored. */
  inviteTokenHash: string
  inviteTokenExpiry: Date
  invitedAt: Date
  consentAt?: Date
  consentVersion?: string
  consentUserAgent?: string
  /** B2C User minted/linked by the guest-auth seam at OTP verification. */
  guestUserId?: mongoose.Types.ObjectId
  authVerifiedAt?: Date
  /** Set when the guest enters the engine flow — the reconciliation window
   * for matching the engine-created InterviewSession opens here. */
  preparedAt?: Date
  /** The engine session this round's results came from. Unique so one
   * interview can never be claimed by two rounds. */
  sessionId?: mongoose.Types.ObjectId
  linkedAt?: Date
  revokedAt?: Date
  revokedBy?: mongoose.Types.ObjectId
  config: {
    role: string
    interviewType: string
    experience: string
    duration: number
  }
  /** sha256 of the job's jdText at send time — reconciliation match key. */
  jdHash: string
  results?: HireRoundResults
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireRoundSchema = new Schema<IHireRound>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    candidateEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    candidateName: { type: String, trim: true, maxlength: 120 },
    kind: { type: String, enum: HIRE_ROUND_KINDS, default: 'ai' },
    status: { type: String, enum: HIRE_ROUND_STATUSES, default: 'invited' },
    inviteTokenHash: { type: String, required: true },
    inviteTokenExpiry: { type: Date, required: true },
    invitedAt: { type: Date, required: true },
    consentAt: { type: Date },
    consentVersion: { type: String, maxlength: 40 },
    consentUserAgent: { type: String, maxlength: 512 },
    guestUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    authVerifiedAt: { type: Date },
    preparedAt: { type: Date },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },
    linkedAt: { type: Date },
    revokedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    config: {
      role: { type: String, required: true, maxlength: 200 },
      interviewType: { type: String, required: true, maxlength: 60 },
      experience: { type: String, required: true, maxlength: 10 },
      duration: { type: Number, required: true, min: 5, max: 60 },
    },
    jdHash: { type: String, required: true },
    results: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

HireRoundSchema.index({ workspaceId: 1, applicationId: 1, createdAt: -1 })
// One engine session can back at most one round — the double-claim guard the
// reconciler's atomic claim relies on.
HireRoundSchema.index({ sessionId: 1 }, { unique: true, sparse: true })
// Reconciliation scan: unlinked rounds for a guest user.
HireRoundSchema.index({ guestUserId: 1, status: 1 }, { sparse: true })

export const HireRound: Model<IHireRound> =
  mongoose.models.HireRound || mongoose.model<IHireRound>('HireRound', HireRoundSchema)
