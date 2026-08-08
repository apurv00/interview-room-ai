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
  /** Engine sessions observed for this round at last reconcile (completed +
   * in-progress). >1 means the candidate started the interview more than
   * once — surfaced on the card, never hidden. */
  attemptCount?: number
  /** Present (true) only while the round is claimable/in-flight. Backs the
   * partial unique index enforcing ONE live AI round per application even
   * under concurrent sends. Unset on revoke and on completion-claim. */
  live?: boolean
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
    authMode: { type: String, enum: ['magic_link', 'otp'], required: true, immutable: true },
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
    jdSnapshot: { type: String, required: true, maxlength: 50000 },
    attemptCount: { type: Number },
    live: { type: Boolean },
    results: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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
// One engine session can back at most one round — the double-claim guard the
// reconciler's atomic claim relies on.
HireRoundSchema.index({ sessionId: 1 }, { unique: true, sparse: true })
// Reconciliation scan: unlinked rounds for a guest user.
HireRoundSchema.index({ guestUserId: 1, status: 1 }, { sparse: true })

export const HireRound: Model<IHireRound> =
  mongoose.models.HireRound || mongoose.model<IHireRound>('HireRound', HireRoundSchema)
