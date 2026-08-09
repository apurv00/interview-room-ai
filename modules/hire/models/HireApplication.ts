import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * Fixed pipeline (build plan §Pipeline). Order matters: "advance" moves one
 * step right; 'hired' and 'rejected' are terminal. The AI never moves a card —
 * every stage transition is an explicit member action with actor + timestamp
 * recorded in the events array.
 */
export const HIRE_STAGES = [
  'new',
  'screened',
  'interviewing',
  'shortlist',
  'offer',
  'hired',
  'rejected',
] as const
export type HireStage = (typeof HIRE_STAGES)[number]
export const TERMINAL_STAGES: readonly HireStage[] = ['hired', 'rejected']

export const HIRE_EVENT_TYPES = [
  'created',
  'stage_move',
  'ai_round_sent',
  'ai_round_revoked',
  'ai_result_linked',
  // Recruiter adjudication of public submissions — the ONLY sanctioned
  // exception to evidence monotonicity (founder ruling 2026-08-09), so
  // both are attributed and permanently recorded.
  'submission_promoted',
  'submission_deleted',
] as const
export type HireEventType = (typeof HIRE_EVENT_TYPES)[number]

export interface IHireApplicationEvent {
  type: HireEventType
  from?: string
  to?: string
  /** Member User id for member actions; absent for system events (reconciler). */
  actorUserId?: mongoose.Types.ObjectId
  /** Display name recorded at event time — 'System' for automatic linking. */
  actorName: string
  note?: string
  at: Date
}

/**
 * Resume-vs-JD match produced at intake (Phase 2). Job-specific — the same
 * candidate scores differently against different JDs, so it lives on the
 * application, not the candidate. Typed subdoc on purpose: results-shaped
 * Mixed fields get no schema validation (HireRound.results lesson).
 */
export interface IHireResumeMatch {
  /** 0–100, null when the scoring call failed (candidate still created). */
  score: number | null
  strengths: string[]
  gaps: string[]
  scoredAt: Date
  /** sha256 of job.jdText at scoring time — a mismatch means the JD changed. */
  jdHash: string
  /**
   * sha256 of the resumeText this match was computed FROM. The candidate's
   * resume is workspace-level and shared across applications, so a newer CV
   * uploaded for job B silently invalidates job A's score — this hash plus
   * the `stale` flag (set by the intake staleness sweep) make that
   * detectable instead of quietly misleading (Codex P1 on #612).
   */
  resumeHash: string
  /** True when the underlying resume was replaced after this match was scored. */
  stale?: boolean
}

/** One public apply-page submission, with the score it produced. */
export interface IHireApplicantSubmission {
  /** Stable identity. Array position is NOT identity — a submission
   *  arriving between page load and action would shift every index and
   *  make the recruiter promote or delete a different document than the
   *  one they read (Codex P1 on #618). */
  _id?: mongoose.Types.ObjectId
  resumeText: string
  resumeFileName?: string
  submittedAt: Date
  /** Match computed from THIS document (advisory — may be absent). */
  match?: IHireResumeMatch
}

/** Newest-first retention bound for append-only public submissions. */
export const APPLICANT_SUBMISSION_CAP = 3

export interface IHireApplication extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  stage: HireStage
  /** Required when the stage becomes 'hired' (enforced in pipelineService). */
  decisionNote?: string
  resumeMatch?: IHireResumeMatch
  /**
   * Résumés submitted through the PUBLIC apply page, APPEND-ONLY.
   *
   * A single mutable slot was a vulnerability: anyone holding the shared
   * link who knows an applicant's email could overwrite that person's
   * résumé and score with a fabrication, corrupting the evidence a
   * recruiter decides on (Codex P1 on #615). Nothing anonymous may
   * overwrite anything — later submissions are appended and shown
   * alongside, which also makes a tampering attempt visible rather than
   * silent. Capped (APPLICANT_SUBMISSION_CAP) so an unauthenticated caller
   * cannot grow the document without bound.
   */
  applicantSubmissions?: IHireApplicantSubmission[]
  events: IHireApplicationEvent[]
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const HireResumeMatchSchema = new Schema<IHireResumeMatch>(
  {
    score: { type: Number, min: 0, max: 100, default: null },
    strengths: { type: [String], default: [] },
    gaps: { type: [String], default: [] },
    scoredAt: { type: Date, required: true },
    jdHash: { type: String, required: true, maxlength: 64 },
    resumeHash: { type: String, required: true, maxlength: 64 },
    stale: { type: Boolean },
  },
  { _id: false }
)

const HireApplicantSubmissionSchema = new Schema<IHireApplicantSubmission>(
  {
    resumeText: { type: String, required: true, maxlength: 50000 },
    resumeFileName: { type: String, maxlength: 255 },
    submittedAt: { type: Date, required: true },
    match: { type: HireResumeMatchSchema },
  },
  // _id ENABLED deliberately: adjudication addresses a submission by id.
  { _id: true }
)

const HireApplicationEventSchema = new Schema<IHireApplicationEvent>(
  {
    type: { type: String, enum: HIRE_EVENT_TYPES, required: true },
    from: { type: String, maxlength: 40 },
    to: { type: String, maxlength: 40 },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, required: true, maxlength: 120 },
    note: { type: String, maxlength: 4000 },
    at: { type: Date, required: true },
  },
  { _id: false }
)

const HireApplicationSchema = new Schema<IHireApplication>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
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
    stage: { type: String, enum: HIRE_STAGES, default: 'new' },
    decisionNote: { type: String, maxlength: 4000 },
    resumeMatch: { type: HireResumeMatchSchema },
    applicantSubmissions: { type: [HireApplicantSubmissionSchema], default: undefined },
    events: { type: [HireApplicationEventSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

// One application per candidate per job.
HireApplicationSchema.index({ workspaceId: 1, jobId: 1, candidateId: 1 }, { unique: true })
// Pipeline board reads: all applications of a job grouped by stage.
HireApplicationSchema.index({ workspaceId: 1, jobId: 1, stage: 1 })

export const HireApplication: Model<IHireApplication> =
  mongoose.models.HireApplication ||
  mongoose.model<IHireApplication>('HireApplication', HireApplicationSchema)
