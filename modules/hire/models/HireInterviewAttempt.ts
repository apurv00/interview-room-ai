import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_INTERVIEW_ATTEMPT_STATUSES = [
  'photo_pending',
  'ready',
  'in_progress',
  'processing',
  'completed',
  'failed',
  'superseded',
  'revoked',
] as const
export type HireInterviewAttemptStatus = (typeof HIRE_INTERVIEW_ATTEMPT_STATUSES)[number]

export interface IHireInterviewAttempt extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  sequence: number
  status: HireInterviewAttemptStatus
  live?: boolean
  consentReceiptId: mongoose.Types.ObjectId
  identityPhotoAssetId?: mongoose.Types.ObjectId
  resultId?: mongoose.Types.ObjectId
  recordingEpoch?: Date
  startedAt?: Date
  completedAt?: Date
  failedAt?: Date
  failureCode?: string
  supersededBy?: mongoose.Types.ObjectId
  retakeReason?: string
  createdAt: Date
  updatedAt: Date
}

const HireInterviewAttemptSchema = new Schema<IHireInterviewAttempt>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    sequence: { type: Number, required: true, immutable: true, min: 1 },
    status: { type: String, enum: HIRE_INTERVIEW_ATTEMPT_STATUSES, required: true },
    live: { type: Boolean },
    consentReceiptId: {
      type: Schema.Types.ObjectId,
      ref: 'HireConsentReceipt',
      required: true,
      immutable: true,
    },
    identityPhotoAssetId: { type: Schema.Types.ObjectId, ref: 'HireMediaAsset' },
    resultId: { type: Schema.Types.ObjectId, ref: 'HireInterviewResult' },
    recordingEpoch: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    failureCode: { type: String, maxlength: 120 },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'HireInterviewAttempt' },
    retakeReason: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
)

HireInterviewAttemptSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, sequence: 1 },
  { unique: true }
)
HireInterviewAttemptSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, live: 1 },
  { unique: true, partialFilterExpression: { live: true } }
)
HireInterviewAttemptSchema.index({ workspaceId: 1, candidateId: 1, createdAt: -1 })

export const HireInterviewAttempt: Model<IHireInterviewAttempt> =
  mongoose.models.HireInterviewAttempt ||
  mongoose.model<IHireInterviewAttempt>('HireInterviewAttempt', HireInterviewAttemptSchema)
