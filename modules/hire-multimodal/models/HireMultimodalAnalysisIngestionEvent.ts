import mongoose, { Document, Model, Schema } from 'mongoose'

export interface IHireMultimodalAnalysisIngestionEvent extends Document {
  _id: mongoose.Types.ObjectId
  eventId: string
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  runtimeSessionId: mongoose.Types.ObjectId
  attempt: number
  revision: number
  inputDigest: string
  status: 'received' | 'processed'
  terminalOutcome?: 'processed' | 'stale'
  processedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireMultimodalAnalysisIngestionEventSchema =
  new Schema<IHireMultimodalAnalysisIngestionEvent>(
    {
      eventId: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
      workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      candidateId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      attempt: { type: Number, required: true, min: 1, max: 10, immutable: true },
      revision: { type: Number, required: true, min: 1, max: 10, immutable: true },
      inputDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
      status: { type: String, enum: ['received', 'processed'], required: true, default: 'received' },
      terminalOutcome: { type: String, enum: ['processed', 'stale'] },
      processedAt: { type: Date },
    },
    { timestamps: true, strict: 'throw' },
  )

HireMultimodalAnalysisIngestionEventSchema.index({ eventId: 1 }, { unique: true })
HireMultimodalAnalysisIngestionEventSchema.index(
  { workspaceId: 1, roundId: 1, runtimeSessionId: 1, attempt: 1, revision: 1 },
  { unique: true },
)
HireMultimodalAnalysisIngestionEventSchema.index({ workspaceId: 1, candidateId: 1 })

export const HireMultimodalAnalysisIngestionEvent: Model<IHireMultimodalAnalysisIngestionEvent> =
  mongoose.models.HireMultimodalAnalysisIngestionEvent ||
  mongoose.model<IHireMultimodalAnalysisIngestionEvent>(
    'HireMultimodalAnalysisIngestionEvent',
    HireMultimodalAnalysisIngestionEventSchema,
  )
