import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_AI_INVITE_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
] as const
export type HireAiInviteDeliveryStatus =
  (typeof HIRE_AI_INVITE_DELIVERY_STATUSES)[number]

/** Durable Hire-control delivery state for one AI invitation. */
export interface IHireAiInviteDelivery extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  recipientEmail: string
  recipientName: string
  jobTitle: string
  workspaceName: string
  verifyByCode: boolean
  expiresAt: Date
  envelopeVersion: 1
  keyId: string
  ciphertext: string
  iv: string
  authTag: string
  status: HireAiInviteDeliveryStatus
  attempts: number
  claimToken?: string
  leaseExpiresAt?: Date
  sentAt?: Date
  providerMessageId?: string
  lastError?: string
  manualRetryCount: number
  lastManualRetryAt?: Date
  lastManualRetryByMemberId?: mongoose.Types.ObjectId
  lastManualRetryByName?: string
  createdAt: Date
  updatedAt: Date
}

const HireAiInviteDeliverySchema = new Schema<IHireAiInviteDelivery>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    roundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      immutable: true,
    },
    recipientName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    jobTitle: { type: String, required: true, maxlength: 200, immutable: true },
    workspaceName: { type: String, required: true, maxlength: 120, immutable: true },
    verifyByCode: { type: Boolean, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    envelopeVersion: { type: Number, enum: [1], required: true, immutable: true },
    keyId: { type: String, required: true, maxlength: 120, immutable: true },
    ciphertext: { type: String, required: true, maxlength: 512, immutable: true },
    iv: { type: String, required: true, maxlength: 64, immutable: true },
    authTag: { type: String, required: true, maxlength: 64, immutable: true },
    status: { type: String, enum: HIRE_AI_INVITE_DELIVERY_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    claimToken: { type: String, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    sentAt: { type: Date },
    providerMessageId: { type: String, maxlength: 240 },
    lastError: { type: String, maxlength: 2000 },
    manualRetryCount: { type: Number, default: 0, min: 0 },
    lastManualRetryAt: { type: Date },
    lastManualRetryByMemberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember' },
    lastManualRetryByName: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true },
)

HireAiInviteDeliverySchema.index({ workspaceId: 1, roundId: 1 }, { unique: true })
HireAiInviteDeliverySchema.index({ workspaceId: 1, status: 1, leaseExpiresAt: 1 })
HireAiInviteDeliverySchema.index({ workspaceId: 1, candidateId: 1, roundId: 1 })
// TTL cleanup is defence in depth. Every read/send also checks expiry because
// Mongo's TTL monitor is asynchronous.
HireAiInviteDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const HireAiInviteDelivery: Model<IHireAiInviteDelivery> =
  mongoose.models.HireAiInviteDelivery ||
  mongoose.model<IHireAiInviteDelivery>('HireAiInviteDelivery', HireAiInviteDeliverySchema)
