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

export interface IHireApplication extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  stage: HireStage
  /** Required when the stage becomes 'hired' (enforced in pipelineService). */
  decisionNote?: string
  events: IHireApplicationEvent[]
  createdBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

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
