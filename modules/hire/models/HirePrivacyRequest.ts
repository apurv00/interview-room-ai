import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_PRIVACY_REQUEST_STATUSES = [
  'pending_verification',
  'processing',
  'completed',
  'expired',
  'failed',
] as const
export type HirePrivacyRequestStatus = (typeof HIRE_PRIVACY_REQUEST_STATUSES)[number]

export interface IHirePrivacyRequest extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  requestedViaRoundId: mongoose.Types.ObjectId
  verificationEmailHash: string
  verificationCapabilityHash: string
  verificationExpiresAt: Date
  status: HirePrivacyRequestStatus
  live?: boolean
  requestedAt: Date
  verifiedAt?: Date
  processingAt?: Date
  completedAt?: Date
  failureCode?: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Privacy requests are active while verified deletion is processing, or while
 * the candidate can still verify a pending request. A stale unverified row
 * deliberately remains auditable, but must not indefinitely suppress safe
 * aggregate/read-model work after its capability expires.
 */
export function activeHirePrivacyRequestFilter(now: Date): {
  live: true
  $or: [
    { status: 'processing' },
    { status: 'pending_verification'; verificationExpiresAt: { $gt: Date } },
  ]
} {
  return {
    live: true,
    $or: [
      { status: 'processing' },
      { status: 'pending_verification', verificationExpiresAt: { $gt: now } },
    ],
  }
}

const HirePrivacyRequestSchema = new Schema<IHirePrivacyRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    requestedViaRoundId: { type: Schema.Types.ObjectId, ref: 'HireRound', required: true, immutable: true },
    verificationEmailHash: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    verificationCapabilityHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    verificationExpiresAt: { type: Date, required: true },
    status: { type: String, enum: HIRE_PRIVACY_REQUEST_STATUSES, required: true },
    live: { type: Boolean },
    requestedAt: { type: Date, required: true, immutable: true },
    verifiedAt: { type: Date },
    processingAt: { type: Date },
    completedAt: { type: Date },
    failureCode: { type: String, maxlength: 160 },
  },
  { timestamps: true }
)

HirePrivacyRequestSchema.index(
  { workspaceId: 1, candidateId: 1, live: 1 },
  { unique: true, partialFilterExpression: { live: true } }
)
HirePrivacyRequestSchema.index({ status: 1, verificationExpiresAt: 1 })

export const HirePrivacyRequest: Model<IHirePrivacyRequest> =
  mongoose.models.HirePrivacyRequest ||
  mongoose.model<IHirePrivacyRequest>('HirePrivacyRequest', HirePrivacyRequestSchema)
