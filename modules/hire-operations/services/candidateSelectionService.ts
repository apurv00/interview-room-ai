import mongoose, { type ClientSession } from "mongoose";
import { AppError } from "@shared/errors";
import {
  HIRE_STAGES,
  type HireStage,
  type MembershipContext,
} from "@hire-operations-boundary";
import type {
  HireCandidateSelectionMetadata,
  HireJobCandidateNormalizedQuery,
} from "../candidateTypes";
import { HIRE_JOB_CANDIDATE_SELECTION_MAX } from "../candidateTypes";
import {
  HireCandidateSelectionSnapshot,
  type IHireCandidateSelectionSnapshot,
} from "../models/HireCandidateSelectionSnapshot";
import {
  canonicalCandidateQuery,
  type HireCandidateSelectionCreatePayload,
} from "../validators/candidateWorkspace";
import {
  resolveExplicitHireJobCandidateEntries,
  resolveHireJobCandidateQueryEntries,
} from "./candidateListService";
import {
  connectHireOperationsDB,
  withActiveHireWorkspaceWriteTransaction,
} from "./hireOperationsBoundary";

export const HIRE_CANDIDATE_SELECTION_TTL_MS = 15 * 60 * 1_000;

export class HireCandidateSelectionError extends AppError {
  constructor(
    message: string,
    readonly code:
      | "CANDIDATE_SELECTION_INVALID_SCOPE"
      | "CANDIDATE_SELECTION_EMPTY"
      | "CANDIDATE_SELECTION_NOT_FOUND"
      | "CANDIDATE_SELECTION_EXPIRED",
    status: 400 | 404 | 409 = 400,
  ) {
    super(message, status, code);
    this.name = "HireCandidateSelectionError";
  }
}

function id(value: unknown, label: string): string {
  const stringValue = value?.toString();
  if (typeof stringValue !== "string" || !mongoose.Types.ObjectId.isValid(stringValue)) {
    throw new HireCandidateSelectionError(
      `Invalid ${label}`,
      "CANDIDATE_SELECTION_INVALID_SCOPE",
    );
  }
  return stringValue;
}

function validNow(now?: Date): Date {
  const value = now ? new Date(now.getTime()) : new Date();
  if (Number.isNaN(value.getTime())) {
    throw new HireCandidateSelectionError(
      "Invalid selection timestamp",
      "CANDIDATE_SELECTION_INVALID_SCOPE",
    );
  }
  return value;
}

function filterDescription(query: HireJobCandidateNormalizedQuery, count: number): string {
  const codes = (values: readonly string[]) => [...values].sort().join(",") || "all";
  const range = (from?: string | number, to?: string | number) =>
    from === undefined && to === undefined ? "any" : `${from ?? "*"}..${to ?? "*"}`;
  const description = [
    `All matching · ${count} candidate${count === 1 ? "" : "s"}`,
    query.q ? "search applied" : undefined,
    `view=${query.view}`,
    `stage=${codes(query.stage)}`,
    `source=${codes(query.source)}`,
    `jd_state=${codes(query.scoreState)}`,
    `jd_range=${range(query.scoreMin, query.scoreMax)}`,
    `human=${codes(query.humanReview)}`,
    `ai=${codes(query.aiInterview)}`,
    `history=${query.history ?? "any"}`,
    `applied=${range(query.appliedFrom, query.appliedTo)}`,
    `sort=${query.sort}:${query.direction}`,
  ].filter(Boolean).join(" · ");
  if (description.length > 500) throw new Error("Candidate filter description overflow");
  return description;
}

function homogeneousStage(
  entries: ReadonlyArray<{ expectedStage: HireStage }>,
): HireStage | null {
  const first = entries[0]?.expectedStage;
  return first && entries.every((entry) => entry.expectedStage === first)
    ? first
    : null;
}

function metadata(
  snapshot: Pick<
    IHireCandidateSelectionSnapshot,
    "_id" | "count" | "expiresAt" | "description" | "entries"
  >,
): HireCandidateSelectionMetadata {
  return {
    selectionId: snapshot._id.toString(),
    count: snapshot.count,
    expiresAt: snapshot.expiresAt.toISOString(),
    description: snapshot.description,
    homogeneousStage: homogeneousStage(snapshot.entries),
  };
}

export async function createCandidateSelectionSnapshot(
  ctx: MembershipContext,
  input: {
    jobId: string;
    payload: HireCandidateSelectionCreatePayload;
    now?: Date;
  },
): Promise<HireCandidateSelectionMetadata> {
  const now = validNow(input.now);
  const workspaceId = id(ctx.workspace._id, "workspace id");
  const memberId = id(ctx.membership._id, "member id");
  const jobId = id(input.jobId, "job id");
  const normalizedQuery = input.payload.mode === "all_matching"
    ? canonicalCandidateQuery(input.payload.query)
    : undefined;
  return withActiveHireWorkspaceWriteTransaction(
    new mongoose.Types.ObjectId(workspaceId),
    new mongoose.Types.ObjectId(memberId),
    async (session) => {
      const entries = input.payload.mode === "explicit"
        ? await resolveExplicitHireJobCandidateEntries({
            workspaceId, jobId, applicationIds: input.payload.applicationIds, now, session,
          })
        : await resolveHireJobCandidateQueryEntries({
            workspaceId, jobId, query: normalizedQuery!,
            max: HIRE_JOB_CANDIDATE_SELECTION_MAX, now, session,
          });
      if (entries.length === 0) {
        throw new HireCandidateSelectionError(
          "The current selection contains no available candidates",
          "CANDIDATE_SELECTION_EMPTY",
          409,
        );
      }
      const description = input.payload.mode === "explicit"
        ? `Selected candidates · ${entries.length} candidate${entries.length === 1 ? "" : "s"}`
        : filterDescription(normalizedQuery!, entries.length);
      const expiresAt = new Date(now.getTime() + HIRE_CANDIDATE_SELECTION_TTL_MS);
      const created = await HireCandidateSelectionSnapshot.create([{
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        jobId: new mongoose.Types.ObjectId(jobId),
        memberId: new mongoose.Types.ObjectId(memberId),
        mode: input.payload.mode,
        entries: entries.map((entry) => ({
          applicationId: new mongoose.Types.ObjectId(entry.applicationId),
          expectedStage: entry.expectedStage,
        })),
        count: entries.length,
        description,
        expiresAt,
      }], { session });
      return metadata(created[0]);
    },
  );
}

export interface CandidateSelectionSnapshotRead {
  selectionId: string;
  jobId: string;
  applicationIds: string[];
  entries: Array<{ applicationId: string; expectedStage: HireStage }>;
  count: number;
  description: string;
  expiresAt: Date;
  homogeneousStage: HireStage | null;
}

/**
 * Transaction-safe authority read for screening and durable bulk commands.
 * The immutable IDs are never returned by the public metadata route.
 */
export async function readCandidateSelectionSnapshot(
  ctx: MembershipContext,
  input: {
    jobId: string;
    selectionId: string;
    now?: Date;
    session?: ClientSession;
  },
): Promise<CandidateSelectionSnapshotRead> {
  const now = validNow(input.now);
  const workspaceId = id(ctx.workspace._id, "workspace id");
  const memberId = id(ctx.membership._id, "member id");
  const jobId = id(input.jobId, "job id");
  const selectionId = id(input.selectionId, "selection id");
  await connectHireOperationsDB();
  let query = HireCandidateSelectionSnapshot.findOne({
    _id: new mongoose.Types.ObjectId(selectionId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    jobId: new mongoose.Types.ObjectId(jobId),
    memberId: new mongoose.Types.ObjectId(memberId),
  });
  if (input.session) query = query.session(input.session);
  const snapshot = await query.lean<{
    entries: Array<{ applicationId: mongoose.Types.ObjectId; expectedStage: HireStage }>;
    count: number;
    description: string;
    expiresAt: Date;
  }>();
  if (!snapshot) {
    throw new HireCandidateSelectionError(
      "Candidate selection was not found",
      "CANDIDATE_SELECTION_NOT_FOUND",
      404,
    );
  }
  if (!(snapshot.expiresAt instanceof Date) || snapshot.expiresAt <= now) {
    throw new HireCandidateSelectionError(
      "Candidate selection has expired; refresh the list and select again",
      "CANDIDATE_SELECTION_EXPIRED",
      409,
    );
  }
  if (
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length !== snapshot.count ||
    snapshot.count < 1 ||
    snapshot.count > HIRE_JOB_CANDIDATE_SELECTION_MAX ||
    snapshot.entries.some(
      (entry) =>
        !entry?.applicationId || !HIRE_STAGES.includes(entry.expectedStage),
    ) ||
    new Set(snapshot.entries.map((entry) => entry.applicationId.toString())).size !==
      snapshot.entries.length
  ) {
    throw new Error("Candidate selection snapshot invariant failed");
  }
  const entries = snapshot.entries.map((entry) => ({
    applicationId: entry.applicationId.toString(),
    expectedStage: entry.expectedStage,
  }));
  return {
    selectionId,
    jobId,
    applicationIds: entries.map((entry) => entry.applicationId),
    entries,
    count: snapshot.count,
    description: snapshot.description,
    expiresAt: snapshot.expiresAt,
    homogeneousStage: homogeneousStage(entries),
  };
}

export async function readCandidateSelectionMetadata(
  ctx: MembershipContext,
  input: { jobId: string; selectionId: string; now?: Date },
): Promise<HireCandidateSelectionMetadata> {
  const snapshot = await readCandidateSelectionSnapshot(ctx, input);
  return {
    selectionId: input.selectionId,
    count: snapshot.count,
    expiresAt: snapshot.expiresAt.toISOString(),
    description: snapshot.description,
    homogeneousStage: snapshot.homogeneousStage,
  };
}

export async function releaseCandidateSelectionSnapshot(
  ctx: MembershipContext,
  input: { jobId: string; selectionId: string },
): Promise<boolean> {
  const workspaceId = id(ctx.workspace._id, "workspace id");
  const memberId = id(ctx.membership._id, "member id");
  const jobId = id(input.jobId, "job id");
  const selectionId = id(input.selectionId, "selection id");
  await connectHireOperationsDB();
  const result = await HireCandidateSelectionSnapshot.deleteOne({
    _id: new mongoose.Types.ObjectId(selectionId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    jobId: new mongoose.Types.ObjectId(jobId),
    memberId: new mongoose.Types.ObjectId(memberId),
  });
  return result.deletedCount === 1;
}

/** TTL is authoritative; this bounded explicit purge supports deterministic maintenance/tests. */
export async function purgeExpiredCandidateSelectionSnapshots(input: {
  now?: Date;
  limit?: number;
} = {}): Promise<number> {
  const now = validNow(input.now);
  const limit = input.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new HireCandidateSelectionError(
      "Invalid selection purge limit",
      "CANDIDATE_SELECTION_INVALID_SCOPE",
    );
  }
  await connectHireOperationsDB();
  const expired = await HireCandidateSelectionSnapshot.find({ expiresAt: { $lte: now } })
    .sort({ expiresAt: 1, _id: 1 })
    .limit(limit)
    .select("_id")
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
  if (expired.length === 0) return 0;
  const result = await HireCandidateSelectionSnapshot.deleteMany({
    _id: { $in: expired.map((item) => item._id) },
    expiresAt: { $lte: now },
  });
  return result.deletedCount;
}
