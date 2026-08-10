import mongoose, { Document, Model, Schema } from 'mongoose'

export type HireEngineIngestionEventStatus = 'received' | 'processed' | 'conflict'

export interface IHireEngineIngestionEvent extends Document {
  eventId: string
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  runtimeSessionId: mongoose.Types.ObjectId
  revision: number
  attempt: number
  resultDigest: string
  media: Array<Record<string, unknown>>
  status: HireEngineIngestionEventStatus
  conflictReason?: string
  processedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireEngineIngestionEventSchema = new Schema<IHireEngineIngestionEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    runtimeSessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    revision: { type: Number, required: true, min: 1, max: 10, immutable: true },
    attempt: { type: Number, required: true, min: 1, max: 10, immutable: true },
    resultDigest: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    media: { type: Schema.Types.Mixed, required: true, default: [] },
    status: {
      type: String,
      enum: ['received', 'processed', 'conflict'],
      required: true,
      default: 'received',
    },
    conflictReason: { type: String, maxlength: 1_000 },
    processedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

HireEngineIngestionEventSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, revision: -1 },
)
HireEngineIngestionEventSchema.index(
  { roundId: 1, runtimeSessionId: 1, revision: 1 },
  { unique: true },
)

export const HireEngineIngestionEvent: Model<IHireEngineIngestionEvent> =
  mongoose.models.HireEngineIngestionEvent ||
  mongoose.model<IHireEngineIngestionEvent>(
    'HireEngineIngestionEvent',
    HireEngineIngestionEventSchema,
  )
