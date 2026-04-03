import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IFailedJob extends Document {
  jobId: string
  functionId: string
  eventName: string
  stepName?: string
  sessionId?: string
  userId?: string
  error: string
  stack?: string
  attemptNumber: number
  payload?: Record<string, unknown>
  createdAt: Date
}

const FailedJobSchema = new Schema<IFailedJob>(
  {
    jobId: { type: String, required: true, index: true },
    functionId: { type: String, required: true, index: true },
    eventName: { type: String, required: true },
    stepName: { type: String },
    sessionId: { type: String, index: true },
    userId: { type: String },
    error: { type: String, required: true },
    stack: { type: String },
    attemptNumber: { type: Number, default: 1 },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
)

FailedJobSchema.index({ createdAt: -1 })
FailedJobSchema.index({ functionId: 1, createdAt: -1 })

export const FailedJob: Model<IFailedJob> =
  mongoose.models.FailedJob ||
  mongoose.model<IFailedJob>('FailedJob', FailedJobSchema)
