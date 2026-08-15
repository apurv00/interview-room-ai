import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  type HireExternalVerdictRecommendation,
} from '../types'

/**
 * A share-packet response is deliberately not a `HireHumanScorecard`: it has
 * no round, rubric dimensions, evidence array, reviewer authority, or edit
 * lifecycle. It is one immutable external recommendation for one packet.
 */
export interface IHireExternalVerdict extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  packetId: mongoose.Types.ObjectId
  recommendation: HireExternalVerdictRecommendation
  comment?: string
  submittedAt: Date
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const HireExternalVerdictSchema = new Schema<IHireExternalVerdict>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    packetId: { type: Schema.Types.ObjectId, ref: 'HireSharePacket', required: true, immutable: true },
    recommendation: {
      type: String,
      enum: HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
      required: true,
      immutable: true,
    },
    comment: { type: String, trim: true, minlength: 1, maxlength: 2_000, immutable: true },
    submittedAt: { type: Date, required: true, immutable: true },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true, strict: 'throw' },
)

// Exactly one external recommendation can ever consume a packet capability.
HireExternalVerdictSchema.index({ workspaceId: 1, packetId: 1 }, { unique: true })
HireExternalVerdictSchema.index({ workspaceId: 1, applicationId: 1, submittedAt: -1 })
// Privacy and retention redaction fence for optional external comment prose.
HireExternalVerdictSchema.index({ workspaceId: 1, candidateId: 1 })

export const HireExternalVerdict: Model<IHireExternalVerdict> =
  mongoose.models.HireExternalVerdict ||
  mongoose.model<IHireExternalVerdict>('HireExternalVerdict', HireExternalVerdictSchema)
