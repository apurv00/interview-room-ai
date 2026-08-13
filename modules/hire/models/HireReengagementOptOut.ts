import mongoose, { Document, Model, Schema } from 'mongoose'

/**
 * A Hire-owned, workspace-scoped suppression record for talent-pool
 * re-engagement mail. It deliberately stores no email address or raw public
 * capability: the candidate row remains the only contact-data authority and
 * the unsubscribe capability is signed only when an email is dispatched.
 */
export interface IHireReengagementOptOut extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  optedOutAt: Date
  createdAt: Date
  updatedAt: Date
}

const HireReengagementOptOutSchema = new Schema<IHireReengagementOptOut>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'HireCandidate',
      required: true,
      immutable: true,
    },
    optedOutAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: true },
)

// One persistent choice per tenant-owned candidate. A candidate can be
// contacted by a different workspace only through that workspace's own row.
HireReengagementOptOutSchema.index(
  { workspaceId: 1, candidateId: 1 },
  { unique: true },
)

export const HireReengagementOptOut: Model<IHireReengagementOptOut> =
  mongoose.models.HireReengagementOptOut ||
  mongoose.model<IHireReengagementOptOut>(
    'HireReengagementOptOut',
    HireReengagementOptOutSchema,
  )
