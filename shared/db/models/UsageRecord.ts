import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IUsageRecord extends Document {
  _id: mongoose.Types.ObjectId

  userId: mongoose.Types.ObjectId
  organizationId?: mongoose.Types.ObjectId

  type: 'interview_session' | 'api_call_question' | 'api_call_evaluate' | 'api_call_feedback' | 'ats_check' | 'jd_parse' | 'resume_tailor'
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
      // + the jobs quota seams (PRODUCT_FLOW §2): recorded from launch, gated by nothing until P-1 resolves.
      enum: ['interview_session', 'api_call_question', 'api_call_evaluate', 'api_call_feedback', 'ats_check', 'jd_parse', 'resume_tailor'],
      required: true,
    },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    modelUsed: { type: String, default: 'claude-sonnet-4-6' },
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
