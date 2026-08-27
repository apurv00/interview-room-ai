import mongoose, { type ClientSession, type Document, type Model, Schema } from "mongoose";
import { HIRE_STAGES, type HireStage } from "@hire-operations-boundary";
import {
  HIRE_CANDIDATE_SELECTION_MODES,
  HIRE_JOB_CANDIDATE_SELECTION_MAX,
  type HireCandidateSelectionMode,
} from "../candidateTypes";

export interface IHireCandidateSelectionSnapshotEntry {
  applicationId: mongoose.Types.ObjectId;
  expectedStage: HireStage;
}

export interface IHireCandidateSelectionSnapshot extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
  mode: HireCandidateSelectionMode;
  entries: IHireCandidateSelectionSnapshotEntry[];
  count: number;
  description: string;
  expiresAt: Date;
  createdAt: Date;
}

const EntrySchema = new Schema<IHireCandidateSelectionSnapshotEntry>(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: "HireApplication",
      required: true,
      immutable: true,
    },
    expectedStage: {
      type: String,
      enum: HIRE_STAGES,
      required: true,
      immutable: true,
    },
  },
  { _id: false, strict: "throw" },
);

const SnapshotSchema = new Schema<IHireCandidateSelectionSnapshot>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "HireWorkspace",
      required: true,
      immutable: true,
    },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: "HireJob",
      required: true,
      immutable: true,
    },
    memberId: {
      type: Schema.Types.ObjectId,
      ref: "HireWorkspaceMember",
      required: true,
      immutable: true,
    },
    mode: {
      type: String,
      enum: HIRE_CANDIDATE_SELECTION_MODES,
      required: true,
      immutable: true,
    },
    entries: {
      type: [EntrySchema],
      required: true,
      immutable: true,
      validate: {
        validator: (entries: IHireCandidateSelectionSnapshotEntry[]) =>
          Array.isArray(entries) &&
          entries.length >= 1 &&
          entries.length <= HIRE_JOB_CANDIDATE_SELECTION_MAX &&
          new Set(entries.map((entry) => entry.applicationId.toString())).size ===
            entries.length,
        message: `Selection entries must contain 1-${HIRE_JOB_CANDIDATE_SELECTION_MAX} unique applications`,
      },
    },
    count: {
      type: Number,
      required: true,
      min: 1,
      max: HIRE_JOB_CANDIDATE_SELECTION_MAX,
      immutable: true,
      validate: {
        validator: function (this: unknown, count: number) {
          const entries = (this as { entries?: unknown[] }).entries;
          return Number.isInteger(count) && entries?.length === count;
        },
        message: "Selection count must equal the immutable entry count",
      },
    },
    description: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 500,
      immutable: true,
    },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
    autoIndex: false,
    autoCreate: false,
  },
);

SnapshotSchema.index(
  { workspaceId: 1, jobId: 1, memberId: 1, expiresAt: 1, _id: 1 },
  { name: "workspaceId_1_jobId_1_memberId_1_expiresAt_1__id_1" },
);
SnapshotSchema.index(
  { expiresAt: 1 },
  { name: "expiresAt_1", expireAfterSeconds: 0 },
);

export const HireCandidateSelectionSnapshot: Model<IHireCandidateSelectionSnapshot> =
  mongoose.models.HireCandidateSelectionSnapshot ||
  mongoose.model<IHireCandidateSelectionSnapshot>(
    "HireCandidateSelectionSnapshot",
    SnapshotSchema,
  );

/** Type-only convenience used by transactional snapshot consumers. */
export type HireCandidateSelectionSession = ClientSession;
