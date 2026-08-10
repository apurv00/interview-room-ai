import mongoose, { Document, Model, Schema } from 'mongoose'
import type { HireEngineConfig } from '@shared/contracts/hireEngineBridge'

export interface IHireEngineHandoff extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  codeHash: string
  requestBindingHash?: string
  config: HireEngineConfig
  consentVersion: string
  consentAt: Date
  inviteExpiresAt: Date
  expiresAt: Date
  redeemedBy?: string
  redeemedAt?: Date
  revokedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireEngineHandoffSchema = new Schema<IHireEngineHandoff>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    codeHash: {
      type: String,
      required: true,
      immutable: true,
      unique: true,
      match: /^[a-f0-9]{64}$/,
    },
    requestBindingHash: { type: String, match: /^[a-f0-9]{64}$/ },
    config: {
      role: { type: String, required: true, maxlength: 100 },
      interviewType: { type: String, required: true, maxlength: 50 },
      experience: { type: String, enum: ['0-2', '3-6', '7+'], required: true },
      duration: { type: Number, min: 5, max: 30, required: true },
      jobDescription: { type: String, required: true, maxlength: 50_000 },
      targetCompany: { type: String, maxlength: 200 },
    },
    consentVersion: { type: String, required: true, maxlength: 80 },
    consentAt: { type: Date, required: true, immutable: true },
    inviteExpiresAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    redeemedBy: { type: String, maxlength: 64 },
    redeemedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

HireEngineHandoffSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, createdAt: -1 },
)
HireEngineHandoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

export const HireEngineHandoff: Model<IHireEngineHandoff> =
  mongoose.models.HireEngineHandoff ||
  mongoose.model<IHireEngineHandoff>('HireEngineHandoff', HireEngineHandoffSchema)
