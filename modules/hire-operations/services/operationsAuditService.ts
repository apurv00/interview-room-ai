import mongoose, { type PipelineStage } from "mongoose";
import { AppError } from "@shared/errors";
import {
  HireApplication,
  HireCandidate,
  HireJob,
  HirePrivacyRequest,
  activeHirePrivacyRequestFilter,
} from "@hire-operations-boundary";
import { HireReportExport } from "@/modules/hire-reports/models/HireReportExport";
import { HireCandidateStatusLink } from "@/modules/hire-status/models/HireCandidateStatusLink";
import { HireDigestOutbox } from "@/modules/hire-digest/models/HireDigestOutbox";
import { HireOnboardingTestDrive } from "@/modules/hire-onboarding/models/HireOnboardingTestDrive";
import { buildHireOnboardingTestDriveExclusionStages } from "@/modules/hire-onboarding/services/testDriveService";
import type {
  HireOperationsAuditActor,
  HireOperationsAuditItem,
  HireOperationsAuditKind,
  HireOperationsAuditPage,
  HireOperationsAuditTargetKind,
} from "../types";
import { connectHireOperationsDB } from "./hireOperationsBoundary";

export const HIRE_OPERATIONS_AUDIT_DEFAULT_LIMIT = 25;
export const HIRE_OPERATIONS_AUDIT_MAX_LIMIT = 100;

const APPLICATION_AUDIT_KIND_BY_EVENT: Readonly<
  Record<string, HireOperationsAuditKind | undefined>
> = {
  created: "application_created",
  reapplied: "application_reapplied",
  source_merged: "application_source_merged",
  stage_move: "application_stage_changed",
  ai_round_sent: "application_ai_round_sent",
  ai_round_revoked: "application_ai_round_revoked",
  ai_result_linked: "application_ai_result_linked",
  human_round_logged: "application_human_round_logged",
  human_kit_sent: "application_human_kit_sent",
  human_kit_delivery_failed: "application_human_kit_delivery_failed",
  human_kit_reminded: "application_human_kit_reminded",
  human_kit_revoked: "application_human_kit_revoked",
  human_scorecard_submitted: "application_human_scorecard_submitted",
};

const APPLICATION_AUDIT_EVENT_TYPES = Object.keys(
  APPLICATION_AUDIT_KIND_BY_EVENT,
);

const STATIC_AUDIT_KIND_BY_SOURCE: Readonly<
  Record<string, Readonly<Record<string, HireOperationsAuditKind | undefined>>>
> = {
  job: { status_change: "job_status_changed" },
  report: {
    requested: "report_requested",
    generating: "report_generation_started",
    ready: "report_ready",
    failed: "report_failed",
    expired: "report_expired",
    cancelled: "report_cancelled",
  },
  status_link: {
    issued: "status_link_issued",
    revoked: "status_link_revoked",
  },
  digest_outbox: {
    queued: "digest_delivery_queued",
    sent: "digest_delivery_sent",
    cancelled: "digest_delivery_cancelled",
  },
  onboarding_test_drive: {
    started: "onboarding_test_drive_started",
    ready: "onboarding_test_drive_ready",
    removed: "onboarding_test_drive_removed",
  },
};

const AUDIT_ID =
  /^(application|job|report|status_link|digest_outbox|onboarding_test_drive):[a-f0-9]{24}:\d+$/i;

type AuditSource =
  | "application"
  | "job"
  | "report"
  | "status_link"
  | "digest_outbox"
  | "onboarding_test_drive";

type AuditCursor = {
  v: 1;
  occurredAt: Date;
  id: string;
};

type RawAuditEvent = {
  auditId?: unknown;
  workspaceId?: unknown;
  candidateId?: unknown;
  privacyRedactedAt?: unknown;
  source?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  actorName?: unknown;
  targetId?: unknown;
};

/** Internal sort coordinate. It is encoded into the opaque cursor, never sent in an item DTO. */
type InternalAuditItem = HireOperationsAuditItem & {
  cursorId: string;
};

/**
 * Test-drive markers are durable aggregate exclusions. Keep the join at every
 * graph root rather than inferring synthetic records from user-facing labels.
 */
function excludeHireOnboardingTestDrives(input: {
  coordinate: "applicationId" | "jobId" | "candidateId" | "roundId";
  sourceIdField?: string;
}): PipelineStage[] {
  return buildHireOnboardingTestDriveExclusionStages(
    input,
  ) as unknown as PipelineStage[];
}

export class HireOperationsAuditError extends AppError {
  constructor(
    message: string,
    readonly code:
      | "OPERATIONS_AUDIT_INVALID_CURSOR"
      | "OPERATIONS_AUDIT_INVALID_LIMIT"
      | "OPERATIONS_AUDIT_INVALID_SCOPE",
  ) {
    super(message, 400, code);
    this.name = "HireOperationsAuditError";
  }
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HireOperationsAuditError(
      `Invalid ${label}`,
      "OPERATIONS_AUDIT_INVALID_SCOPE",
    );
  }
  return new mongoose.Types.ObjectId(value);
}

function recordId(value: unknown): string | null {
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function parseCursorPayload(value: unknown): AuditCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HireOperationsAuditError(
      "Audit cursor is invalid",
      "OPERATIONS_AUDIT_INVALID_CURSOR",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "id,occurredAt,v" ||
    record.v !== 1 ||
    typeof record.occurredAt !== "string" ||
    typeof record.id !== "string" ||
    !AUDIT_ID.test(record.id)
  ) {
    throw new HireOperationsAuditError(
      "Audit cursor is invalid",
      "OPERATIONS_AUDIT_INVALID_CURSOR",
    );
  }
  const occurredAt = new Date(record.occurredAt);
  if (!validDate(occurredAt)) {
    throw new HireOperationsAuditError(
      "Audit cursor is invalid",
      "OPERATIONS_AUDIT_INVALID_CURSOR",
    );
  }
  return { v: 1, occurredAt, id: record.id.toLowerCase() };
}

/** Validate the opaque pagination token without exposing its internals to callers. */
export function parseHireOperationsAuditCursor(
  value: string | undefined,
): AuditCursor | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 512) {
      throw new HireOperationsAuditError(
        "Audit cursor is invalid",
        "OPERATIONS_AUDIT_INVALID_CURSOR",
      );
    }
    return parseCursorPayload(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch (error) {
    if (error instanceof HireOperationsAuditError) throw error;
    throw new HireOperationsAuditError(
      "Audit cursor is invalid",
      "OPERATIONS_AUDIT_INVALID_CURSOR",
    );
  }
}

function encodeCursor(item: InternalAuditItem): string {
  return Buffer.from(
    JSON.stringify({ v: 1, occurredAt: item.occurredAt, id: item.cursorId }),
    "utf8",
  ).toString("base64url");
}

function pageSize(value: number | undefined): number {
  const limit = value ?? HIRE_OPERATIONS_AUDIT_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > HIRE_OPERATIONS_AUDIT_MAX_LIMIT
  ) {
    throw new HireOperationsAuditError(
      "Audit limit is invalid",
      "OPERATIONS_AUDIT_INVALID_LIMIT",
    );
  }
  return limit;
}

function cursorStages(cursor: AuditCursor | null): PipelineStage[] {
  if (!cursor) return [];
  return [
    {
      $match: {
        $or: [
          { occurredAt: { $lt: cursor.occurredAt } },
          { occurredAt: cursor.occurredAt, auditId: { $lt: cursor.id } },
        ],
      },
    },
  ];
}

function finalStages(
  cursor: AuditCursor | null,
  take: number,
): PipelineStage[] {
  return [
    ...cursorStages(cursor),
    { $sort: { occurredAt: -1, auditId: -1 } },
    { $limit: take },
  ];
}

function applicationPipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  candidateIds: mongoose.Types.ObjectId[];
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    {
      $match: {
        workspaceId: input.workspaceId,
        candidateId: { $in: input.candidateIds },
      },
    },
    ...excludeHireOnboardingTestDrives({ coordinate: "applicationId" }),
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    {
      $match: {
        "events.type": { $in: APPLICATION_AUDIT_EVENT_TYPES },
        "events.at": { $type: "date" },
      },
    },
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        candidateId: { $toString: "$candidateId" },
        source: { $literal: "application" },
        eventType: "$events.type",
        occurredAt: "$events.at",
        actorName: "$events.actorName",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "application:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

function jobPipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    { $match: { workspaceId: input.workspaceId } },
    ...excludeHireOnboardingTestDrives({ coordinate: "jobId" }),
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    {
      $match: {
        "events.type": "status_change",
        "events.at": { $type: "date" },
      },
    },
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        source: { $literal: "job" },
        eventType: "$events.type",
        occurredAt: "$events.at",
        actorName: "$events.actorName",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "job:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

function reportPipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    {
      $match: {
        workspaceId: input.workspaceId,
        privacyRedactedAt: { $exists: false },
      },
    },
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        privacyRedactedAt: 1,
        events: [
          {
            eventType: { $literal: "requested" },
            occurredAt: "$requestedAt",
            actorName: "$requestedByName",
          },
          {
            eventType: { $literal: "generating" },
            occurredAt: "$generatingAt",
          },
          { eventType: { $literal: "ready" }, occurredAt: "$readyAt" },
          { eventType: { $literal: "failed" }, occurredAt: "$failedAt" },
          { eventType: { $literal: "expired" }, occurredAt: "$expiredAt" },
          { eventType: { $literal: "cancelled" }, occurredAt: "$cancelledAt" },
        ],
      },
    },
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    { $match: { "events.occurredAt": { $type: "date" } } },
    {
      $project: {
        workspaceId: 1,
        privacyRedactedAt: 1,
        source: { $literal: "report" },
        eventType: "$events.eventType",
        occurredAt: "$events.occurredAt",
        actorName: "$events.actorName",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "report:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

function statusLinkPipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  candidateIds: mongoose.Types.ObjectId[];
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    {
      $match: {
        workspaceId: input.workspaceId,
        candidateId: { $in: input.candidateIds },
        privacyRedactedAt: { $exists: false },
      },
    },
    ...excludeHireOnboardingTestDrives({
      coordinate: "applicationId",
      sourceIdField: "applicationId",
    }),
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        candidateId: { $toString: "$candidateId" },
        privacyRedactedAt: 1,
        events: [
          {
            eventType: { $literal: "issued" },
            occurredAt: "$issuedAt",
            actorName: "$issuedByName",
          },
          {
            eventType: { $literal: "revoked" },
            occurredAt: "$revokedAt",
            actorName: "$revokedByName",
          },
        ],
      },
    },
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    { $match: { "events.occurredAt": { $type: "date" } } },
    {
      $project: {
        workspaceId: 1,
        candidateId: 1,
        privacyRedactedAt: 1,
        source: { $literal: "status_link" },
        eventType: "$events.eventType",
        occurredAt: "$events.occurredAt",
        actorName: "$events.actorName",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "status_link:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

function digestOutboxPipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    { $match: { workspaceId: input.workspaceId } },
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        events: [
          { eventType: { $literal: "queued" }, occurredAt: "$createdAt" },
          { eventType: { $literal: "sent" }, occurredAt: "$sentAt" },
          {
            eventType: { $literal: "cancelled" },
            occurredAt: "$cancelledAt",
          },
        ],
      },
    },
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    { $match: { "events.occurredAt": { $type: "date" } } },
    {
      $project: {
        workspaceId: 1,
        source: { $literal: "digest_outbox" },
        eventType: "$events.eventType",
        occurredAt: "$events.occurredAt",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "digest_outbox:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

/**
 * The test-drive marker is the bounded, Hire-only source of onboarding audit
 * receipts. Project only the timestamp/action and member actor snapshot: the
 * synthetic candidate, application, job, round, operation, and cleanup
 * coordinates must never reach this member audit surface.
 */
function onboardingTestDrivePipeline(input: {
  workspaceId: mongoose.Types.ObjectId;
  cursor: AuditCursor | null;
  take: number;
}): PipelineStage[] {
  return [
    { $match: { workspaceId: input.workspaceId } },
    {
      $project: {
        workspaceId: { $toString: "$workspaceId" },
        events: [
          {
            eventType: { $literal: "started" },
            occurredAt: "$createdAt",
            actorName: "$issuedByName",
          },
          {
            eventType: { $literal: "ready" },
            occurredAt: "$inviteReleasedAt",
            actorName: "$issuedByName",
          },
          {
            eventType: { $literal: "removed" },
            occurredAt: "$removedAt",
            actorName: "$removedByName",
          },
        ],
      },
    },
    { $unwind: { path: "$events", includeArrayIndex: "eventIndex" } },
    { $match: { "events.occurredAt": { $type: "date" } } },
    {
      $project: {
        workspaceId: 1,
        source: { $literal: "onboarding_test_drive" },
        eventType: "$events.eventType",
        occurredAt: "$events.occurredAt",
        actorName: "$events.actorName",
        targetId: { $toString: "$_id" },
        auditId: {
          $concat: [
            "onboarding_test_drive:",
            { $toString: "$_id" },
            ":",
            { $toString: "$eventIndex" },
          ],
        },
      },
    },
    ...finalStages(input.cursor, input.take),
  ];
}

function source(value: unknown): AuditSource | null {
  return value === "application" ||
    value === "job" ||
    value === "report" ||
    value === "status_link" ||
    value === "digest_outbox" ||
    value === "onboarding_test_drive"
    ? value
    : null;
}

function kindFor(
  sourceName: AuditSource,
  eventType: unknown,
): HireOperationsAuditKind | null {
  if (typeof eventType !== "string") return null;
  const kind =
    sourceName === "application"
      ? APPLICATION_AUDIT_KIND_BY_EVENT[eventType]
      : STATIC_AUDIT_KIND_BY_SOURCE[sourceName]?.[eventType];
  return kind ?? null;
}

function targetKindFor(sourceName: AuditSource): HireOperationsAuditTargetKind {
  if (sourceName === "application") return "application";
  if (sourceName === "job") return "job";
  if (sourceName === "report") return "report";
  if (sourceName === "status_link") return "status_link";
  if (sourceName === "onboarding_test_drive") return "onboarding_test_drive";
  return "digest_outbox";
}

function actorFromName(value: unknown): HireOperationsAuditActor {
  if (typeof value !== "string") return { kind: "system", name: "System" };
  const name = value.trim();
  if (!name || name.length > 120 || name.toLowerCase() === "system") {
    return { kind: "system", name: "System" };
  }
  return { kind: "member", name };
}

/** Matches MongoDB's default binary string ordering used by the pipeline. */
function compareAuditIdDescending(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function compareAuditItems(
  left: InternalAuditItem,
  right: InternalAuditItem,
): number {
  const timestamp = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
  return timestamp !== 0
    ? timestamp
    : compareAuditIdDescending(left.cursorId, right.cursorId);
}

function isAfterCursor(
  item: InternalAuditItem,
  cursor: AuditCursor | null,
): boolean {
  if (!cursor) return true;
  const timestamp = Date.parse(item.occurredAt);
  const cursorTimestamp = cursor.occurredAt.getTime();
  return (
    timestamp < cursorTimestamp ||
    (timestamp === cursorTimestamp && item.cursorId < cursor.id)
  );
}

function rawAuditItem(input: {
  row: RawAuditEvent;
  workspaceId: string;
  activeCandidateIds: ReadonlySet<string>;
}): InternalAuditItem | null {
  const sourceName = source(input.row.source);
  const id = typeof input.row.auditId === "string" ? input.row.auditId : "";
  const rowWorkspaceId = recordId(input.row.workspaceId);
  const targetId = recordId(input.row.targetId);
  if (
    !sourceName ||
    !AUDIT_ID.test(id) ||
    rowWorkspaceId !== input.workspaceId ||
    !targetId ||
    !mongoose.Types.ObjectId.isValid(targetId) ||
    !validDate(input.row.occurredAt) ||
    input.row.privacyRedactedAt !== undefined
  ) {
    return null;
  }
  if (sourceName === "application" || sourceName === "status_link") {
    const candidateId = recordId(input.row.candidateId);
    if (!candidateId || !input.activeCandidateIds.has(candidateId)) return null;
  }
  const kind = kindFor(sourceName, input.row.eventType);
  if (!kind) return null;
  return {
    cursorId: id,
    kind,
    occurredAt: input.row.occurredAt.toISOString(),
    actor: actorFromName(input.row.actorName),
    target: { kind: targetKindFor(sourceName), id: targetId },
  };
}

async function readAuditRows(input: {
  workspaceId: mongoose.Types.ObjectId;
  activeCandidateIds: mongoose.Types.ObjectId[];
  cursor: AuditCursor | null;
  take: number;
}): Promise<RawAuditEvent[]> {
  const [jobRows, reportRows, digestRows, onboardingTestDriveRows] =
    await Promise.all([
      HireJob.aggregate(
        jobPipeline({
          workspaceId: input.workspaceId,
          cursor: input.cursor,
          take: input.take,
        }),
      ),
      HireReportExport.aggregate(
        reportPipeline({
          workspaceId: input.workspaceId,
          cursor: input.cursor,
          take: input.take,
        }),
      ),
      HireDigestOutbox.aggregate(
        digestOutboxPipeline({
          workspaceId: input.workspaceId,
          cursor: input.cursor,
          take: input.take,
        }),
      ),
      HireOnboardingTestDrive.aggregate(
        onboardingTestDrivePipeline({
          workspaceId: input.workspaceId,
          cursor: input.cursor,
          take: input.take,
        }),
      ),
    ]);
  if (input.activeCandidateIds.length === 0) {
    return [
      ...(jobRows as RawAuditEvent[]),
      ...(reportRows as RawAuditEvent[]),
      ...(digestRows as RawAuditEvent[]),
      ...(onboardingTestDriveRows as RawAuditEvent[]),
    ];
  }
  const [applicationRows, statusLinkRows] = await Promise.all([
    HireApplication.aggregate(
      applicationPipeline({
        workspaceId: input.workspaceId,
        candidateIds: input.activeCandidateIds,
        cursor: input.cursor,
        take: input.take,
      }),
    ),
    HireCandidateStatusLink.aggregate(
      statusLinkPipeline({
        workspaceId: input.workspaceId,
        candidateIds: input.activeCandidateIds,
        cursor: input.cursor,
        take: input.take,
      }),
    ),
  ]);
  return [
    ...(jobRows as RawAuditEvent[]),
    ...(reportRows as RawAuditEvent[]),
    ...(digestRows as RawAuditEvent[]),
    ...(onboardingTestDriveRows as RawAuditEvent[]),
    ...(applicationRows as RawAuditEvent[]),
    ...(statusLinkRows as RawAuditEvent[]),
  ];
}

/**
 * Read a member workspace's immutable-source audit projection. It never
 * creates audit records: application/job event arrays and safe Phase-5
 * report/status metadata remain the sources of truth.
 */
export async function readHireWorkspaceAudit(input: {
  workspaceId: string;
  cursor?: string;
  limit?: number;
}): Promise<HireOperationsAuditPage> {
  const workspaceId = objectId(input.workspaceId, "workspace id");
  const limit = pageSize(input.limit);
  const cursor = parseHireOperationsAuditCursor(input.cursor);
  const now = new Date();
  await connectHireOperationsDB();
  const [activeCandidates, livePrivacyRequests] = await Promise.all([
    HireCandidate.aggregate([
      {
        $match: {
          workspaceId,
          piiAnonymizedAt: { $exists: false },
        },
      },
      ...excludeHireOnboardingTestDrives({ coordinate: "candidateId" }),
      { $project: { _id: 1 } },
    ]),
    HirePrivacyRequest.find({ workspaceId, ...activeHirePrivacyRequestFilter(now) })
      .select("candidateId")
      .lean(),
  ]);
  const privacyPendingCandidateIds = new Set(
    livePrivacyRequests.map((request) => request.candidateId.toString()),
  );
  const activeCandidateIds = activeCandidates
    .map((candidate) => candidate._id)
    .filter(
      (candidateId) => !privacyPendingCandidateIds.has(candidateId.toString()),
    );
  const activeCandidateIdStrings = new Set(
    activeCandidateIds.map((candidateId) => candidateId.toString()),
  );
  const rows = await readAuditRows({
    workspaceId,
    activeCandidateIds,
    cursor,
    take: limit + 1,
  });
  const items = rows
    .map((row) =>
      rawAuditItem({
        row,
        workspaceId: workspaceId.toString(),
        activeCandidateIds: activeCandidateIdStrings,
      }),
    )
    .filter((item): item is InternalAuditItem => item !== null)
    .filter((item) => isAfterCursor(item, cursor))
    .sort(compareAuditItems);
  const pageItems = items.slice(0, limit);
  const last = pageItems.at(-1);
  return {
    items: pageItems.map(({ cursorId: _cursorId, ...item }) => item),
    nextCursor: items.length > limit && last ? encodeCursor(last) : null,
  };
}

export const __hireOperationsAudit = {
  actorFromName,
  applicationPipeline,
  compareAuditIdDescending,
  compareAuditItems,
  digestOutboxPipeline,
  jobPipeline,
  onboardingTestDrivePipeline,
  rawAuditItem,
  reportPipeline,
  statusLinkPipeline,
};
