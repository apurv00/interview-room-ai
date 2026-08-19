import mongoose, { Document, Model, Schema } from "mongoose";
import type { HireMultimodalObservationReport } from "@shared/contracts/hireMultimodalObservationBridge";

export const HIRE_MULTIMODAL_OBSERVATION_PURGE_REASONS = [
  "job_closed",
] as const;
export type HireMultimodalObservationPurgeReason =
  (typeof HIRE_MULTIMODAL_OBSERVATION_PURGE_REASONS)[number];

/**
 * Recruiter-only supplemental observation record. This is intentionally
 * separate from HireInterviewResult: it must not become input to scoring,
 * ranking, recommendations, decision flows, reports, or exports.
 */
export interface IHireMultimodalObservation extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  applicationId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  candidateId: mongoose.Types.ObjectId;
  roundId: mongoose.Types.ObjectId;
  attemptId: mongoose.Types.ObjectId;
  runtimeSessionId: mongoose.Types.ObjectId;
  schemaVersion: number;
  eventId: string;
  revision: number;
  consentVersion: string;
  policyVersion: string;
  observationDigest: string;
  observedAt: Date;
  report: HireMultimodalObservationReport;
  /** A closed job owns this derived report only until its six-month deadline. */
  purgeEligibleAt?: Date;
  purgeReason?: HireMultimodalObservationPurgeReason;
  createdAt: Date;
  updatedAt: Date;
}

const HireMultimodalObservationEventSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ["browser_window_not_visible", "sustained_camera_away"],
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: ["camera", "browser_visibility"],
      required: true,
      immutable: true,
    },
    startMs: {
      type: Number,
      required: true,
      min: 0,
      max: 30 * 60 * 1_000,
      immutable: true,
    },
    endMs: {
      type: Number,
      required: true,
      min: 0,
      max: 30 * 60 * 1_000,
      immutable: true,
    },
  },
  { _id: false, strict: "throw" },
);

const HireMultimodalObservationSchema = new Schema<IHireMultimodalObservation>(
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
    candidateId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    roundId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    attemptId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    runtimeSessionId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    schemaVersion: {
      type: Number,
      required: true,
      min: 1,
      max: 1,
      immutable: true,
    },
    eventId: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    revision: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
      immutable: true,
    },
    consentVersion: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    policyVersion: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    observationDigest: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    observedAt: { type: Date, required: true, immutable: true },
    purgeEligibleAt: { type: Date },
    purgeReason: {
      type: String,
      enum: HIRE_MULTIMODAL_OBSERVATION_PURGE_REASONS,
    },
    report: {
      status: {
        type: String,
        enum: ["completed", "insufficient_signal"],
        required: true,
        immutable: true,
      },
      capture: {
        camera: {
          type: String,
          enum: ["captured", "unavailable", "insufficient_signal"],
          required: true,
          immutable: true,
        },
        browserVisibility: {
          type: String,
          enum: ["captured", "unavailable", "insufficient_signal"],
          required: true,
          immutable: true,
        },
      },
      events: {
        type: [HireMultimodalObservationEventSchema],
        required: true,
        default: [],
        immutable: true,
      },
    },
  },
  { timestamps: true, strict: "throw" },
);

HireMultimodalObservationSchema.index(
  {
    workspaceId: 1,
    applicationId: 1,
    roundId: 1,
    runtimeSessionId: 1,
    revision: 1,
  },
  { unique: true },
);
HireMultimodalObservationSchema.index({ eventId: 1 }, { unique: true });
HireMultimodalObservationSchema.index({
  workspaceId: 1,
  candidateId: 1,
  observedAt: -1,
});
HireMultimodalObservationSchema.index({
  workspaceId: 1,
  jobId: 1,
  purgeEligibleAt: 1,
});

export const HireMultimodalObservation: Model<IHireMultimodalObservation> =
  mongoose.models.HireMultimodalObservation ||
  mongoose.model<IHireMultimodalObservation>(
    "HireMultimodalObservation",
    HireMultimodalObservationSchema,
  );
