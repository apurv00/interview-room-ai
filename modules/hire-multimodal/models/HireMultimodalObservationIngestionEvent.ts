import mongoose, { Document, Model, Schema } from "mongoose";

export type HireMultimodalObservationIngestionEventStatus =
  "received" | "processed";

/**
 * Minimal idempotency ledger for the signed runtime bridge. It deliberately
 * stores only coordinates and digests, never raw capture data.
 */
export interface IHireMultimodalObservationIngestionEvent extends Document {
  _id: mongoose.Types.ObjectId;
  eventId: string;
  workspaceId: mongoose.Types.ObjectId;
  applicationId: mongoose.Types.ObjectId;
  candidateId: mongoose.Types.ObjectId;
  roundId: mongoose.Types.ObjectId;
  runtimeSessionId: mongoose.Types.ObjectId;
  attempt: number;
  revision: number;
  observationDigest: string;
  status: HireMultimodalObservationIngestionEventStatus;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const HireMultimodalObservationIngestionEventSchema =
  new Schema<IHireMultimodalObservationIngestionEvent>(
    {
      eventId: {
        type: String,
        required: true,
        immutable: true,
        match: /^[a-f0-9]{64}$/,
      },
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
      candidateId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
      runtimeSessionId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
      },
      attempt: {
        type: Number,
        required: true,
        min: 1,
        max: 10,
        immutable: true,
      },
      revision: {
        type: Number,
        required: true,
        min: 1,
        max: 10,
        immutable: true,
      },
      observationDigest: {
        type: String,
        required: true,
        immutable: true,
        match: /^[a-f0-9]{64}$/,
      },
      status: {
        type: String,
        enum: ["received", "processed"],
        required: true,
        default: "received",
      },
      processedAt: { type: Date },
    },
    { timestamps: true, strict: "throw" },
  );

HireMultimodalObservationIngestionEventSchema.index(
  { eventId: 1 },
  { unique: true },
);
HireMultimodalObservationIngestionEventSchema.index(
  { workspaceId: 1, roundId: 1, runtimeSessionId: 1, revision: 1 },
  { unique: true },
);
HireMultimodalObservationIngestionEventSchema.index({
  workspaceId: 1,
  candidateId: 1,
});

export const HireMultimodalObservationIngestionEvent: Model<IHireMultimodalObservationIngestionEvent> =
  mongoose.models.HireMultimodalObservationIngestionEvent ||
  mongoose.model<IHireMultimodalObservationIngestionEvent>(
    "HireMultimodalObservationIngestionEvent",
    HireMultimodalObservationIngestionEventSchema,
  );
