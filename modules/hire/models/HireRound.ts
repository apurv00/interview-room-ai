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

/** Workspace-owned projection delivered by the isolated runtime bridge. */
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
  /** True when the engine's evaluation of this answer failed — its persisted
   * dimensions are fabricated fallbacks and are suppressed here; the card
   * shows the Q&A with an "evaluation failed" note instead of scores. */
  evaluationFailed?: boolean
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
  /** True when the engine deliberately REFUSED to score (no answers / G.10
   * short-form guard, persisted as all-zero sentinels) — scores are null,
   * never 0, and redFlags carry the engine's explanation. */
  unscored?: boolean
  /** True when the guest completed the interview AFTER the round was
   * revoked (they had already reached the engine flow — no engine-side
   * handoff check exists to stop them; see the flagged first-class seam).
   * Results are attached so the outcome is never silently lost, and the
   * card labels them for the workspace to judge. */
  completedAfterRevoke?: boolean
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
  /** Workspace guestAuthMode SNAPSHOTTED at send time — an emailed link's
   * verification semantics must never change after it is in an inbox. */
  authMode: 'magic_link' | 'otp'
  /** sha256 of the emailed 32-byte token; the raw token is never stored. */
  inviteTokenHash: string
  inviteTokenExpiry: Date
  invitedAt: Date
  consentAt?: Date
  consentVersion?: string
  consentUserAgent?: string
  preparedAt?: Date
  /** Monotonic authority for ordering independently issued runtime links. */
  engineHandoffGeneration?: number
  /** Opaque id from the physically isolated runtime database. It is not a
   * ref and can never be populated or dereferenced by the control plane. */
  runtimeSessionId?: mongoose.Types.ObjectId
  resultId?: mongoose.Types.ObjectId
  linkedAt?: Date
  revokedAt?: Date
  revokedBy?: mongoose.Types.ObjectId // legacy B2C actor only
  revokedByMemberId?: mongoose.Types.ObjectId
  revokedByName?: string
  revocationState?: 'not_requested' | 'pending' | 'confirmed' | 'failed'
  revocationConfirmedAt?: Date
  revocationFailureCode?: string
  revocationReason?: string
  runtimePurgeRequested?: boolean
  runtimePurgedAt?: Date
  config: {
    role: string
    interviewType: string
    experience: string
    duration: number
  }
  /**
   * sha256 of jdSnapshot — the reconciliation match key. jdSnapshot embeds a
   * per-round reference line, so this hash is unique PER ROUND: an engine
   * session can only ever match the one round that provisioned it (kills the
   * cross-tenant/cross-round ambiguity class outright).
   */
  jdHash: string
  /** The exact JD text provisioned to the guest (job.jdText at send time +
   * the round reference line). Immutable snapshot — editing the job's JD
   * after sending cannot break or redirect reconciliation. */
  jdSnapshot: string
  attemptCount?: number
  requirementVersionId?: mongoose.Types.ObjectId
  requirementVersion?: number
  requirementHash?: string
  /** Present (true) only while the round is claimable/in-flight. Backs the
   * partial unique index enforcing ONE live AI round per application even
   * under concurrent sends. Unset on revoke and on completion-claim. */
  live?: boolean
  results?: HireRoundResults
  createdBy?: mongoose.Types.ObjectId // legacy B2C actor only
  createdByMemberId: mongoose.Types.ObjectId
  createdByName: string
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
    authMode: { type: String, enum: ['magic_link', 'otp'], required: true, immutable: true },
    inviteTokenHash: { type: String, required: true },
    inviteTokenExpiry: { type: Date, required: true },
    invitedAt: { type: Date, required: true },
    consentAt: { type: Date },
    consentVersion: { type: String, maxlength: 40 },
    consentUserAgent: { type: String, maxlength: 512 },
    preparedAt: { type: Date },
    engineHandoffGeneration: { type: Number, min: 0, default: 0 },
    runtimeSessionId: { type: Schema.Types.ObjectId },
    resultId: { type: Schema.Types.ObjectId, ref: 'HireInterviewResult' },
    linkedAt: { type: Date },
    revokedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokedByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    revokedByName: { type: String, maxlength: 120 },
    revocationState: {
      type: String,
      enum: ['not_requested', 'pending', 'confirmed', 'failed'],
      default: 'not_requested',
    },
    revocationConfirmedAt: { type: Date },
    revocationFailureCode: { type: String, maxlength: 120 },
    revocationReason: { type: String, maxlength: 500 },
    runtimePurgeRequested: { type: Boolean },
    runtimePurgedAt: { type: Date },
    config: {
      role: { type: String, required: true, maxlength: 200 },
      interviewType: { type: String, required: true, maxlength: 60 },
      experience: { type: String, required: true, maxlength: 10 },
      duration: { type: Number, required: true, min: 5, max: 60 },
    },
    jdHash: { type: String, required: true },
    jdSnapshot: { type: String, required: true, maxlength: 50000 },
    attemptCount: { type: Number },
    requirementVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJobRequirementVersion',
    },
    requirementVersion: { type: Number, min: 1 },
    requirementHash: { type: String, match: /^[a-f0-9]{64}$/ },
    live: { type: Boolean },
    results: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    createdByName: { type: String, required: true, maxlength: 120, immutable: true },
  },
  { timestamps: true }
)

HireRoundSchema.index({ workspaceId: 1, applicationId: 1, createdAt: -1 })
// ONE live AI round per application, enforced by the database — the
// check-then-create in sendAiRound is only the friendly-error fast path;
// concurrent sends race into this index and surface as 409.
HireRoundSchema.index(
  { workspaceId: 1, applicationId: 1, live: 1 },
  { unique: true, partialFilterExpression: { live: true } }
)
// Runtime session ids are opaque but unique within an isolated runtime.
HireRoundSchema.index({ runtimeSessionId: 1 }, { unique: true, sparse: true })

export const HireRound: Model<IHireRound> =
  mongoose.models.HireRound || mongoose.model<IHireRound>('HireRound', HireRoundSchema)
