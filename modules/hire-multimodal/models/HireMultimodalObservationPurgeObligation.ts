import mongoose, { Document, Model, Schema } from "mongoose";

export const HIRE_MULTIMODAL_OBSERVATION_PURGE_OBLIGATION_REASONS = [
  "job_closed_retention",
] as const;
export type HireMultimodalObservationPurgeObligationReason =
  (typeof HIRE_MULTIMODAL_OBSERVATION_PURGE_OBLIGATION_REASONS)[number];

/**
 * A durable control-plane barrier for the separate runtime observation outbox.
 * It is intentionally not an interview result and carries no report payload.
 * The control plane deletes its own report only after `runtimePurgedAt` is
 * recorded from a signed, idempotent runtime acknowledgement.
 */
export interface IHireMultimodalObservationPurgeObligation extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  applicationId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  /** Removed during candidate-retention anonymization if runtime retry remains. */
  candidateId?: mongoose.Types.ObjectId;
  roundId: mongoose.Types.ObjectId;
  purgeEligibleAt: Date;
  reason: HireMultimodalObservationPurgeObligationReason;
  runtimePurgeRequestedAt?: Date;
  runtimePurgedAt?: Date;
  runtimePurgeFailureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

const HireMultimodalObservationPurgeObligationSchema =
  new Schema<IHireMultimodalObservationPurgeObligation>(
    {
      workspaceId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      applicationId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      jobId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      candidateId: { type: Schema.Types.ObjectId, immutable: true },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      purgeEligibleAt: { type: Date, required: true, immutable: true },
      reason: {
        type: String,
        enum: HIRE_MULTIMODAL_OBSERVATION_PURGE_OBLIGATION_REASONS,
        required: true,
        immutable: true,
      },
      runtimePurgeRequestedAt: { type: Date },
      runtimePurgedAt: { type: Date },
      runtimePurgeFailureCode: { type: String, maxlength: 160 },
    },
    { timestamps: true, strict: "throw" },
  );

// A round has one retention deadline at a time. Reopening before that deadline
// removes the pending obligation; a later close creates a new one.
HireMultimodalObservationPurgeObligationSchema.index(
  { workspaceId: 1, roundId: 1 },
  { unique: true },
);
HireMultimodalObservationPurgeObligationSchema.index({
  workspaceId: 1,
  purgeEligibleAt: 1,
  runtimePurgedAt: 1,
});
HireMultimodalObservationPurgeObligationSchema.index({
  workspaceId: 1,
  jobId: 1,
  purgeEligibleAt: 1,
});
HireMultimodalObservationPurgeObligationSchema.index({
  workspaceId: 1,
  candidateId: 1,
});

export const HireMultimodalObservationPurgeObligation: Model<IHireMultimodalObservationPurgeObligation> =
  mongoose.models.HireMultimodalObservationPurgeObligation ||
  mongoose.model<IHireMultimodalObservationPurgeObligation>(
    "HireMultimodalObservationPurgeObligation",
    HireMultimodalObservationPurgeObligationSchema,
  );
