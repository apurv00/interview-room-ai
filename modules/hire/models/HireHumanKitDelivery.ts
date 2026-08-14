import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_HUMAN_KIT_DELIVERY_PURPOSES = ['initial', 'reminder'] as const
export type HireHumanKitDeliveryPurpose =
  (typeof HIRE_HUMAN_KIT_DELIVERY_PURPOSES)[number]

export const HIRE_HUMAN_KIT_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const
export type HireHumanKitDeliveryStatus =
  (typeof HIRE_HUMAN_KIT_DELIVERY_STATUSES)[number]

/**
 * Durable delivery/recovery row. This is distinct from AI invite delivery:
 * its token opens a scorecard-only kit and has no engine or guest-session
 * semantics. The encrypted secret is retained only until the kit expires.
 */
export interface IHireHumanKitDelivery extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  humanRoundId: mongoose.Types.ObjectId
  kitId: mongoose.Types.ObjectId
  purpose: HireHumanKitDeliveryPurpose
  recipientEmail: string
  recipientName: string
  dueAt: Date
  expiresAt: Date
  envelopeVersion: 1
  keyId: string
  ciphertext: string
  iv: string
  authTag: string
  status: HireHumanKitDeliveryStatus
  attempts: number
  claimToken?: string
  leaseExpiresAt?: Date
  sentAt?: Date
  providerMessageId?: string
  lastError?: string
  cancelledAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireHumanKitDeliverySchema = new Schema<IHireHumanKitDelivery>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    humanRoundId: { type: Schema.Types.ObjectId, ref: 'HireHumanRound', required: true, immutable: true },
    kitId: { type: Schema.Types.ObjectId, ref: 'HireInterviewKit', required: true, immutable: true },
    purpose: { type: String, enum: HIRE_HUMAN_KIT_DELIVERY_PURPOSES, required: true, immutable: true },
    recipientEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, immutable: true },
    recipientName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    dueAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, immutable: true },
    envelopeVersion: { type: Number, enum: [1], required: true, immutable: true },
    keyId: { type: String, required: true, maxlength: 120, immutable: true },
    ciphertext: { type: String, required: true, maxlength: 512, immutable: true },
    iv: { type: String, required: true, maxlength: 64, immutable: true },
    authTag: { type: String, required: true, maxlength: 64, immutable: true },
    status: { type: String, enum: HIRE_HUMAN_KIT_DELIVERY_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    claimToken: { type: String, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    sentAt: { type: Date },
    providerMessageId: { type: String, maxlength: 240 },
    lastError: { type: String, maxlength: 2000 },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
)

HireHumanKitDeliverySchema.index({ workspaceId: 1, kitId: 1, purpose: 1 }, { unique: true })
HireHumanKitDeliverySchema.index({ workspaceId: 1, status: 1, dueAt: 1, leaseExpiresAt: 1 })
HireHumanKitDeliverySchema.index({ workspaceId: 1, candidateId: 1, humanRoundId: 1 })
// Recovery ciphertext and interviewer recipient PII need not outlive the
// advertised capability. Reads still enforce expiresAt because TTL is async.
HireHumanKitDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const HireHumanKitDelivery: Model<IHireHumanKitDelivery> =
  mongoose.models.HireHumanKitDelivery ||
  mongoose.model<IHireHumanKitDelivery>('HireHumanKitDelivery', HireHumanKitDeliverySchema)
