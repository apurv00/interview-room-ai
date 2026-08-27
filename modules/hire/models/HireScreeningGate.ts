import mongoose, { Document, Model, Schema } from 'mongoose'

/** A confirmed gate never moves a candidate's human pipeline stage. */
export const HIRE_SCREENING_SELECTION_MODES = ['top_n', 'above_threshold'] as const
export type HireScreeningSelectionMode = (typeof HIRE_SCREENING_SELECTION_MODES)[number]

export const HIRE_SCREENING_GATE_STATUSES = ['confirmed', 'cancelled'] as const
export type HireScreeningGateStatus = (typeof HIRE_SCREENING_GATE_STATUSES)[number]

export const HIRE_SCREENING_SCORE_STATES = ['scored', 'stale', 'unscored'] as const
export type HireScreeningScoreState = (typeof HIRE_SCREENING_SCORE_STATES)[number]

export const HIRE_SCREENING_KNOCKOUT_REASONS = ['location', 'experience'] as const
export type HireScreeningKnockoutReason = (typeof HIRE_SCREENING_KNOCKOUT_REASONS)[number]

export const HIRE_SCREENING_SELECTION_REASONS = [
  'top_n',
  'above_threshold',
  'below_cut_line',
  'below_threshold',
  'stale_or_unscored',
  'knockout',
  'manual_include',
  'manual_exclude',
] as const
export type HireScreeningSelectionReason =
  (typeof HIRE_SCREENING_SELECTION_REASONS)[number]

export const HIRE_SCREENING_EXCEPTION_ACTIONS = ['include', 'exclude'] as const
export type HireScreeningExceptionAction = (typeof HIRE_SCREENING_EXCEPTION_ACTIONS)[number]

export const HIRE_SCREENING_GATE_SNAPSHOT_CAP = 5000
export const HIRE_SCREENING_GATE_MAX_EXCEPTIONS = 100

export interface IHireScreeningKnockoutSettings {
  location?: string
  experienceFloorYears?: number
}

/** The policy boundary shown to HR before confirmation. */
export interface IHireScreeningCutLine {
  mode: HireScreeningSelectionMode
  requestedTopN?: number
  scoreThreshold?: number
  applicationId?: mongoose.Types.ObjectId
  rank?: number
  score?: number | null
}

/**
 * Non-PII, immutable account of what the gate evaluated. Candidate names and
 * emails stay on the candidate record and are not duplicated into this audit
 * snapshot.
 */
export interface IHireScreeningRankedApplication {
  applicationId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  applicationCreatedAt: Date
  rank?: number
  score: number | null
  scoreState: HireScreeningScoreState
  knockoutReasons: HireScreeningKnockoutReason[]
  automaticallySelected: boolean
  selected: boolean
  selectionReason: HireScreeningSelectionReason
}

/** A human exception is explicit, attributable, and never inferred by AI. */
export interface IHireScreeningException {
  applicationId: mongoose.Types.ObjectId
  action: HireScreeningExceptionAction
  actorMemberId: mongoose.Types.ObjectId
  actorName: string
  note: string
  at: Date
}

export interface IHireScreeningSelectionHandoff {
  selectionSnapshotId: mongoose.Types.ObjectId; actorMemberId: mongoose.Types.ObjectId
  actorName: string; note: string; at: Date
}

/**
 * A durable, confirmed screening decision for one workspace/job.
 *
 * The preview calculation is pure and happens before this record is made.
 * Persisting the snapshot lets a later invitation worker prove exactly which
 * score, cut-line, known knockout, and human exception led to a batch. This
 * model intentionally contains only Hire-owned IDs; it never points to User.
 */
export interface IHireScreeningGate extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  /** Immutable scoring contract active when HR froze this gate. */
  requirementVersionId: mongoose.Types.ObjectId
  requirementVersion: number
  requirementContentHash: string
  status: HireScreeningGateStatus
  selectionMode: HireScreeningSelectionMode
  topN?: number
  scoreThreshold?: number
  knockoutSettings: IHireScreeningKnockoutSettings
  cutLine: IHireScreeningCutLine
  evaluatedCount: number
  eligibleCount: number
  automaticallySelectedCount: number
  selectedCount: number
  rankedApplications: IHireScreeningRankedApplication[]
  exceptions: IHireScreeningException[]
  selectionHandoff?: IHireScreeningSelectionHandoff
  confirmedByMemberId: mongoose.Types.ObjectId
  confirmedByName: string
  confirmedAt: Date
  cancelledAt?: Date
  cancelledByMemberId?: mongoose.Types.ObjectId
  cancelledByName?: string
  cancelNote?: string
  createdAt: Date
  updatedAt: Date
}

const HireScreeningKnockoutSettingsSchema = new Schema<IHireScreeningKnockoutSettings>(
  {
    location: { type: String, trim: true, maxlength: 160 },
    experienceFloorYears: { type: Number, min: 0, max: 50 },
  },
  { _id: false },
)

const HireScreeningCutLineSchema = new Schema<IHireScreeningCutLine>(
  {
    mode: { type: String, enum: HIRE_SCREENING_SELECTION_MODES, required: true },
    requestedTopN: { type: Number, min: 1, max: HIRE_SCREENING_GATE_SNAPSHOT_CAP },
    scoreThreshold: { type: Number, min: 0, max: 100 },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication' },
    rank: { type: Number, min: 1 },
    score: { type: Number, min: 0, max: 100, default: null },
  },
  { _id: false },
)

const HireScreeningRankedApplicationSchema = new Schema<IHireScreeningRankedApplication>(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    applicationCreatedAt: { type: Date, required: true, immutable: true },
    rank: { type: Number, min: 1, immutable: true },
    score: { type: Number, min: 0, max: 100, default: null, immutable: true },
    scoreState: {
      type: String,
      enum: HIRE_SCREENING_SCORE_STATES,
      required: true,
      immutable: true,
    },
    knockoutReasons: {
      type: [{ type: String, enum: HIRE_SCREENING_KNOCKOUT_REASONS }],
      default: [],
      immutable: true,
    },
    automaticallySelected: { type: Boolean, required: true, immutable: true },
    selected: { type: Boolean, required: true, immutable: true },
    selectionReason: {
      type: String,
      enum: HIRE_SCREENING_SELECTION_REASONS,
      required: true,
      immutable: true,
    },
  },
  { _id: false },
)

const HireScreeningExceptionSchema = new Schema<IHireScreeningException>(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'HireApplication',
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: HIRE_SCREENING_EXCEPTION_ACTIONS,
      required: true,
      immutable: true,
    },
    actorMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    actorName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    note: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { _id: false },
)

const HireScreeningSelectionHandoffSchema = new Schema<IHireScreeningSelectionHandoff>(
  {
    selectionSnapshotId: {
      type: Schema.Types.ObjectId, ref: 'HireCandidateSelectionSnapshot', required: true, immutable: true,
    },
    actorMemberId: {
      type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember', required: true, immutable: true,
    },
    actorName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    note: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { _id: false },
)

const HireScreeningGateSchema = new Schema<IHireScreeningGate>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    requirementVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJobRequirementVersion',
      required: true,
      immutable: true,
    },
    requirementVersion: { type: Number, required: true, min: 1, immutable: true },
    requirementContentHash: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    status: {
      type: String,
      enum: HIRE_SCREENING_GATE_STATUSES,
      default: 'confirmed',
      required: true,
    },
    selectionMode: {
      type: String,
      enum: HIRE_SCREENING_SELECTION_MODES,
      required: true,
      immutable: true,
    },
    topN: {
      type: Number,
      min: 1,
      max: HIRE_SCREENING_GATE_SNAPSHOT_CAP,
      immutable: true,
      required: function (this: unknown) {
        return (this as { selectionMode?: unknown }).selectionMode === 'top_n'
      },
      validate: {
        validator: function (this: unknown, value: number | undefined) {
          return (
            (this as { selectionMode?: unknown }).selectionMode !== 'top_n' ||
            Number.isInteger(value)
          )
        },
        message: 'topN must be an integer when selectionMode is top_n',
      },
    },
    scoreThreshold: {
      type: Number,
      min: 0,
      max: 100,
      immutable: true,
      required: function (this: unknown) {
        return (this as { selectionMode?: unknown }).selectionMode === 'above_threshold'
      },
    },
    knockoutSettings: {
      type: HireScreeningKnockoutSettingsSchema,
      required: true,
      default: {},
      immutable: true,
    },
    cutLine: { type: HireScreeningCutLineSchema, required: true, immutable: true },
    evaluatedCount: { type: Number, required: true, min: 0, immutable: true },
    eligibleCount: { type: Number, required: true, min: 0, immutable: true },
    automaticallySelectedCount: { type: Number, required: true, min: 0, immutable: true },
    selectedCount: { type: Number, required: true, min: 0, immutable: true },
    rankedApplications: {
      type: [HireScreeningRankedApplicationSchema],
      required: true,
      immutable: true,
      validate: {
        validator: (entries: IHireScreeningRankedApplication[]) =>
          Array.isArray(entries) && entries.length <= HIRE_SCREENING_GATE_SNAPSHOT_CAP,
        message: `rankedApplications must contain at most ${HIRE_SCREENING_GATE_SNAPSHOT_CAP} entries`,
      },
    },
    exceptions: {
      type: [HireScreeningExceptionSchema],
      default: [],
      immutable: true,
      validate: {
        validator: (entries: IHireScreeningException[]) => Array.isArray(entries) &&
          entries.length <= HIRE_SCREENING_GATE_MAX_EXCEPTIONS,
        message: `exceptions must contain at most ${HIRE_SCREENING_GATE_MAX_EXCEPTIONS} entries`,
      },
    },
    selectionHandoff: {
      type: HireScreeningSelectionHandoffSchema,
      default: undefined,
      immutable: true,
    },
    confirmedByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    confirmedByName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    confirmedAt: { type: Date, required: true, immutable: true },
    cancelledAt: { type: Date },
    cancelledByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    cancelledByName: { type: String, trim: true, maxlength: 120 },
    cancelNote: { type: String, trim: true, maxlength: 4000 },
  },
  { timestamps: true, strict: 'throw' },
)

HireScreeningGateSchema.index({ workspaceId: 1, jobId: 1, confirmedAt: -1, _id: -1 })
HireScreeningGateSchema.index({ workspaceId: 1, status: 1, jobId: 1, confirmedAt: -1 })

export const HireScreeningGate: Model<IHireScreeningGate> =
  mongoose.models.HireScreeningGate ||
  mongoose.model<IHireScreeningGate>('HireScreeningGate', HireScreeningGateSchema)
