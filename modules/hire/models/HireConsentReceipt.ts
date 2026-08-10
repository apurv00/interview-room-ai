import mongoose, { Document, Model, Schema } from 'mongoose'

export interface HireConsentAcknowledgements {
  recording: true
  identityPhoto: true
  attentionMonitoring: true
  aiEvaluation: true
}

export interface IHireConsentReceipt extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  attemptId: mongoose.Types.ObjectId
  consentVersion: string
  disclosureDigest: string
  accepted: HireConsentAcknowledgements
  acceptedAt: Date
  userAgent?: string
  locale?: string
  createdAt: Date
}

const requiredAcceptance = {
  type: Boolean,
  required: true,
  immutable: true,
  validate: {
    validator: (value: boolean) => value === true,
    message: 'Every disclosed Hire interview activity must be accepted',
  },
} as const

const HireConsentReceiptSchema = new Schema<IHireConsentReceipt>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, ref: 'HireInterviewAttempt', required: true, immutable: true },
    consentVersion: { type: String, required: true, immutable: true, maxlength: 80 },
    disclosureDigest: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    accepted: {
      recording: requiredAcceptance,
      identityPhoto: requiredAcceptance,
      attentionMonitoring: requiredAcceptance,
      aiEvaluation: requiredAcceptance,
    },
    acceptedAt: { type: Date, required: true, immutable: true },
    userAgent: { type: String, immutable: true, maxlength: 512 },
    locale: { type: String, immutable: true, maxlength: 40 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

HireConsentReceiptSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1, attemptId: 1 },
  { unique: true }
)
HireConsentReceiptSchema.index({ workspaceId: 1, candidateId: 1, acceptedAt: -1 })

export const HireConsentReceipt: Model<IHireConsentReceipt> =
  mongoose.models.HireConsentReceipt ||
  mongoose.model<IHireConsentReceipt>('HireConsentReceipt', HireConsentReceiptSchema)
