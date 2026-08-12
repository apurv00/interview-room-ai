import mongoose, { Document, Model, Schema } from 'mongoose'

export interface IHireGuestSession extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  secretHash: string
  csrfHash: string
  expiresAt: Date
  active?: boolean
  revokedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireGuestSessionSchema = new Schema<IHireGuestSession>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, ref: 'HireInterviewAttempt', required: true, immutable: true },
    secretHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    csrfHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    expiresAt: { type: Date, required: true, immutable: true },
    active: { type: Boolean },
    revokedAt: { type: Date },
  },
  { timestamps: true }
)

HireGuestSessionSchema.index({ secretHash: 1 }, { unique: true })
HireGuestSessionSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, attemptId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
)
HireGuestSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
HireGuestSessionSchema.index({ workspaceId: 1, candidateId: 1, active: 1 })

export const HireGuestSession: Model<IHireGuestSession> =
  mongoose.models.HireGuestSession ||
  mongoose.model<IHireGuestSession>('HireGuestSession', HireGuestSessionSchema)
