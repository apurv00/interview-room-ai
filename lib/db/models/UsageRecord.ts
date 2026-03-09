import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IUsageRecord extends Document {
  _id: mongoose.Types.ObjectId

  userId: mongoose.Types.ObjectId
  organizationId?: mongoose.Types.ObjectId

  type: 'interview_session' | 'api_call_question' | 'api_call_evaluate' | 'api_call_feedback'
  sessionId?: mongoose.Types.ObjectId

  inputTokens: number
  outputTokens: number
  modelUsed: string
  costUsd: number

  durationMs: number
  success: boolean
  errorMessage?: string

  createdAt: Date
}

const UsageRecordSchema = new Schema<IUsageRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },

    type: {
      type: String,
      enum: ['interview_session', 'api_call_question', 'api_call_evaluate', 'api_call_feedback'],
      required: true,
    },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    modelUsed: { type: String, default: 'claude-sonnet-4-20250514' },
    costUsd: { type: Number, default: 0 },

    durationMs: { type: Number, default: 0 },
    success: { type: Boolean, default: true },
    errorMessage: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

UsageRecordSchema.index({ userId: 1, createdAt: -1 })
UsageRecordSchema.index({ organizationId: 1, createdAt: -1 })
UsageRecordSchema.index({ type: 1, createdAt: -1 })

export const UsageRecord: Model<IUsageRecord> =
  mongoose.models.UsageRecord ||
  mongoose.model<IUsageRecord>('UsageRecord', UsageRecordSchema)
