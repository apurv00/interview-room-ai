import mongoose, { Document, Model, Schema } from 'mongoose'

/**
 * A minimal, durable suppression marker for a Hire round whose supplemental
 * observation retention deadline has elapsed. It contains no report, media,
 * candidate identity, or runtime principal. The native capture and publisher
 * paths consult it so a delayed browser request or retry cannot recreate an
 * outbox row after the control plane has acknowledged the deadline purge.
 */
export interface IHireRuntimeMultimodalObservationRetentionTombstone extends Document {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  roundId: mongoose.Types.ObjectId
  purgeId: string
  purgeEligibleAt: Date
  purgedAt: Date
  createdAt: Date
  updatedAt: Date
}

const HireRuntimeMultimodalObservationRetentionTombstoneSchema =
  new Schema<IHireRuntimeMultimodalObservationRetentionTombstone>(
    {
      workspaceId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      applicationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      purgeId: {
        type: String,
        required: true,
        immutable: true,
        match: /^[a-f0-9]{24}$/i,
      },
      purgeEligibleAt: { type: Date, required: true, immutable: true },
      purgedAt: { type: Date, required: true, immutable: true },
    },
    { timestamps: true, strict: 'throw' },
  )

HireRuntimeMultimodalObservationRetentionTombstoneSchema.index(
  { workspaceId: 1, applicationId: 1, roundId: 1 },
  { unique: true },
)

export const HireRuntimeMultimodalObservationRetentionTombstone: Model<IHireRuntimeMultimodalObservationRetentionTombstone> =
  mongoose.models.HireRuntimeMultimodalObservationRetentionTombstone ||
  mongoose.model<IHireRuntimeMultimodalObservationRetentionTombstone>(
    'HireRuntimeMultimodalObservationRetentionTombstone',
    HireRuntimeMultimodalObservationRetentionTombstoneSchema,
  )
