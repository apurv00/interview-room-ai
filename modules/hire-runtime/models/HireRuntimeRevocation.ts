import mongoose, { Document, Model, Schema } from 'mongoose'

export interface IHireRuntimeRevocation extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  revokedAt: Date
  reason: string
  purgePersonalData: boolean
  purgeStatus?: 'pending' | 'completed'
  purgedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireRuntimeRevocationSchema = new Schema<IHireRuntimeRevocation>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    revokedAt: { type: Date, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    purgePersonalData: { type: Boolean, required: true, default: false },
    purgeStatus: { type: String, enum: ['pending', 'completed'] },
    purgedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

HireRuntimeRevocationSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1 },
  { unique: true },
)

export const HireRuntimeRevocation: Model<IHireRuntimeRevocation> =
  mongoose.models.HireRuntimeRevocation ||
  mongoose.model<IHireRuntimeRevocation>(
    'HireRuntimeRevocation',
    HireRuntimeRevocationSchema,
  )
