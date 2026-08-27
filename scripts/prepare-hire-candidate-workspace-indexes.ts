#!/usr/bin/env tsx
/**
 * Explicit, non-dropping indexes for the scalable Hire candidate workspace.
 *
 *   npm run prepare:hire-candidate-workspace-indexes
 *   npm run check:hire-candidate-workspace-indexes
 *   npm run prepare:hire-candidate-workspace-indexes -- --apply
 *
 * Plan is disconnected, check is read-only, and apply only creates a missing
 * exact index after every collection and unique invariant has been inspected.
 */

import { pathToFileURL } from "node:url";
import { connectDB } from "../shared/db/connection";
import { HireApplication } from "../modules/hire/models/HireApplication";
import { HireHumanKitDelivery } from "../modules/hire/models/HireHumanKitDelivery";
import { HireHumanRound } from "../modules/hire/models/HireHumanRound";
import { HireIntakeTask } from "../modules/hire/models/HireIntakeTask";
import { HireInvitationBatchItem } from "../modules/hire/models/HireInvitationBatchItem";
import { HireExternalVerdict } from "../modules/hire-decisions/models/HireExternalVerdict";
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
} from "../modules/hire-candidate-actions/models";
import { HireCandidateSelectionSnapshot } from "../modules/hire-operations/models/HireCandidateSelectionSnapshot";

export type HireCandidateWorkspaceIndexMode = "plan" | "check" | "apply" | "help";

type IndexDirection = 1 | -1;
type IndexKey = Readonly<Record<string, IndexDirection>>;
export type HireCandidateWorkspaceIndexTarget =
  | "applications"
  | "intake-tasks"
  | "invitation-batch-items"
  | "candidate-selections"
  | "candidate-bulk-operations"
  | "candidate-bulk-operation-items"
  | "human-rounds"
  | "human-kit-deliveries"
  | "external-verdicts";

export interface HireCandidateWorkspaceIndexDefinition {
  target: HireCandidateWorkspaceIndexTarget;
  name: string;
  key: IndexKey;
  unique: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
  purpose: string;
}

export interface HireCandidateWorkspaceIndexDescription {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
  sparse?: boolean;
  hidden?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
}

export interface HireCandidateWorkspaceIndexCollection {
  createIndex(
    key: IndexKey,
    options: {
      name: string;
      unique?: boolean;
      expireAfterSeconds?: number;
      partialFilterExpression?: Readonly<Record<string, unknown>>;
    },
  ): Promise<string>;
  indexes(): Promise<HireCandidateWorkspaceIndexDescription[]>;
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> };
}

export interface HireCandidateWorkspaceIndexDependencies {
  connect(): Promise<unknown>;
  collections: Record<
    HireCandidateWorkspaceIndexTarget,
    HireCandidateWorkspaceIndexCollection
  >;
}

/** The first five definitions are the query-matrix additions; the rest mirror model indexes. */
export const HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS: readonly HireCandidateWorkspaceIndexDefinition[] = [
  {
    target: "applications",
    name: "hire_candidate_workspace_job_snapshot_read",
    key: { workspaceId: 1, jobId: 1, createdAt: 1, _id: 1 },
    unique: false,
    purpose: "tenant/job snapshot scan and deterministic rank input",
  },
  {
    target: "applications",
    name: "hire_candidate_workspace_history_lookup",
    key: { workspaceId: 1, candidateId: 1, jobId: 1 },
    unique: false,
    purpose: "bounded prior-application count by candidate",
  },
  {
    target: "intake-tasks",
    name: "hire_candidate_intake_status_lookup",
    key: { workspaceId: 1, jobId: 1, applicationId: 1, status: 1 },
    unique: false,
    purpose: "exact queued/processing JD-score state lookup",
  },
  {
    target: "invitation-batch-items",
    name: "hire_candidate_delivery_job_status_summary",
    key: { workspaceId: 1, jobId: 1, status: 1 },
    unique: false,
    purpose: "job overview delivery-status counts",
  },
  {
    target: "invitation-batch-items",
    // Reuse the Phase-2 rollout identity for this exact key. A second name for
    // the same key would be treated as an incompatible production index.
    name: "workspaceId_1_jobId_1_invitationBatchId_1__id_1",
    key: { workspaceId: 1, jobId: 1, invitationBatchId: 1, _id: 1 },
    unique: false,
    purpose: "bounded screening recipient-ledger keyset page",
  },
  {
    target: "candidate-selections",
    name: "workspaceId_1_jobId_1_memberId_1_expiresAt_1__id_1",
    key: { workspaceId: 1, jobId: 1, memberId: 1, expiresAt: 1, _id: 1 },
    unique: false,
    purpose: "member/job-scoped immutable selection lookup",
  },
  {
    target: "candidate-selections",
    name: "expiresAt_1",
    key: { expiresAt: 1 },
    unique: false,
    expireAfterSeconds: 0,
    purpose: "asynchronous expiry cleanup for short-lived selections",
  },
  {
    target: "candidate-bulk-operations",
    name: "hire_candidate_bulk_operation_member_idempotency_unique",
    key: { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
    unique: true,
    purpose: "member-scoped bulk-operation idempotency",
  },
  {
    target: "candidate-bulk-operations",
    name: "hire_candidate_bulk_operation_recovery",
    key: {
      workspaceId: 1,
      status: 1,
      nextRecoveryAt: 1,
      updatedAt: 1,
      _id: 1,
    },
    unique: false,
    purpose: "durable operation recovery",
  },
  {
    target: "candidate-bulk-operations",
    name: "hire_candidate_bulk_operation_job_history",
    key: { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
    unique: false,
    purpose: "stable job-scoped bulk-operation history",
  },
  {
    target: "candidate-bulk-operations",
    name: "hire_candidate_bulk_operation_ttl",
    key: { purgeAt: 1 },
    unique: false,
    expireAfterSeconds: 0,
    purpose: "expire aggregate bulk audit after its documented retention window",
  },
  {
    target: "candidate-bulk-operation-items",
    name: "hire_candidate_bulk_item_application_unique",
    key: { workspaceId: 1, bulkOperationId: 1, applicationId: 1 },
    unique: true,
    partialFilterExpression: { privacyRedactedAt: { $exists: false } },
    purpose: "one live work item per selected application while allowing privacy unlinking",
  },
  {
    target: "candidate-bulk-operation-items",
    name: "hire_candidate_bulk_item_claim",
    key: {
      workspaceId: 1,
      bulkOperationId: 1,
      status: 1,
      nextAttemptAt: 1,
      _id: 1,
    },
    unique: false,
    purpose: "bounded due-item claim and retry",
  },
  {
    target: "candidate-bulk-operation-items",
    name: "hire_candidate_bulk_item_lease_recovery",
    key: {
      workspaceId: 1,
      bulkOperationId: 1,
      status: 1,
      leaseExpiresAt: 1,
      _id: 1,
    },
    unique: false,
    purpose: "bounded expired-lease recovery",
  },
  {
    target: "candidate-bulk-operation-items",
    name: "hire_candidate_bulk_item_issue_page",
    key: { workspaceId: 1, bulkOperationId: 1, status: 1, _id: 1 },
    unique: false,
    purpose: "stable issue/result paging",
  },
  {
    target: "candidate-bulk-operation-items",
    name: "hire_candidate_bulk_item_ttl",
    key: { purgeAt: 1 },
    unique: false,
    expireAfterSeconds: 0,
    purpose: "expire per-candidate outcome coordinates after the support window",
  },
  {
    target: "human-rounds",
    name: "workspaceId_1_jobId_1_status_1_createdAt_-1_applicationId_1__id_1",
    key: {
      workspaceId: 1,
      jobId: 1,
      status: 1,
      createdAt: -1,
      applicationId: 1,
      _id: 1,
    },
    unique: false,
    purpose: "stable pending-scorecard decision inbox",
  },
  {
    target: "human-kit-deliveries",
    name:
      "workspaceId_1_jobId_1_status_1_updatedAt_-1_applicationId_1__id_1_attempts_1",
    key: {
      workspaceId: 1,
      jobId: 1,
      status: 1,
      updatedAt: -1,
      applicationId: 1,
      _id: 1,
      attempts: 1,
    },
    unique: false,
    purpose: "stable terminal-delivery decision inbox",
  },
  {
    target: "external-verdicts",
    name: "workspaceId_1_jobId_1_submittedAt_-1_applicationId_1__id_1",
    key: {
      workspaceId: 1,
      jobId: 1,
      submittedAt: -1,
      applicationId: 1,
      _id: 1,
    },
    unique: false,
    purpose: "stable external-verdict decision inbox",
  },
];

const INDEX_TARGETS = Array.from(
  new Set(HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.map(({ target }) => target)),
) as HireCandidateWorkspaceIndexTarget[];

export function hireCandidateWorkspaceIndexModeOf(
  argv: string[],
): HireCandidateWorkspaceIndexMode {
  const supported = new Set(["--apply", "--check", "--help", "-h"]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  const help = argv.includes("--help") || argv.includes("-h");
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  if (help && argv.length > 1) throw new Error("--help cannot be combined");
  if (apply && check) throw new Error("--apply and --check are mutually exclusive");
  if (help) return "help";
  return apply ? "apply" : check ? "check" : "plan";
}

function sameKey(actual: Record<string, unknown> | undefined, expected: IndexKey): boolean {
  const actualEntries = Object.entries(actual ?? {});
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([field, direction], position) =>
        field === expectedEntries[position]?.[0] &&
        direction === expectedEntries[position]?.[1],
    )
  );
}

export function isExactHireCandidateWorkspaceIndex(
  index: HireCandidateWorkspaceIndexDescription,
  definition: HireCandidateWorkspaceIndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    index.expireAfterSeconds === definition.expireAfterSeconds &&
    index.sparse !== true &&
    index.hidden !== true &&
    JSON.stringify(index.partialFilterExpression) ===
      JSON.stringify(definition.partialFilterExpression) &&
    index.collation === undefined
  );
}

type Inspection = {
  definition: HireCandidateWorkspaceIndexDefinition;
  exact: boolean;
  conflicts: HireCandidateWorkspaceIndexDescription[];
};

function inspect(
  indexes: Record<
    HireCandidateWorkspaceIndexTarget,
    HireCandidateWorkspaceIndexDescription[]
  >,
): Inspection[] {
  return HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.map((definition) => {
    const conflicts = indexes[definition.target].filter(
      (index) => index.name === definition.name || sameKey(index.key, definition.key),
    );
    return {
      definition,
      conflicts,
      exact:
        conflicts.length === 1 &&
        isExactHireCandidateWorkspaceIndex(conflicts[0], definition),
    };
  });
}

function incompatible(entries: Inspection[]): Inspection[] {
  return entries.filter(({ exact, conflicts }) => !exact && conflicts.length > 0);
}

function missing(entries: Inspection[]): Inspection[] {
  return entries.filter(({ conflicts }) => conflicts.length === 0);
}

function assertCompatible(entries: Inspection[]): void {
  const failures = incompatible(entries);
  if (!failures.length) return;
  throw new Error(
    `incompatible candidate-workspace index name/key: ${failures
      .map(({ definition }) => `${definition.target}.${definition.name}`)
      .join(", ")}; no index was changed`,
  );
}

function assertExact(entries: Inspection[]): void {
  assertCompatible(entries);
  const absent = missing(entries);
  if (absent.length) {
    throw new Error(
      `missing exact candidate-workspace indexes: ${absent
        .map(({ definition }) => `${definition.target}.${definition.name}`)
        .join(", ")}`,
    );
  }
}

function namespaceMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (((error as { code?: unknown }).code === 26) ||
      (error as { codeName?: unknown }).codeName === "NamespaceNotFound")
  );
}

function defaultCollections(): HireCandidateWorkspaceIndexDependencies["collections"] {
  return {
    applications: HireApplication.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "intake-tasks": HireIntakeTask.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "invitation-batch-items":
      HireInvitationBatchItem.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "candidate-selections":
      HireCandidateSelectionSnapshot.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "candidate-bulk-operations":
      HireCandidateBulkOperation.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "candidate-bulk-operation-items":
      HireCandidateBulkOperationItem.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "human-rounds": HireHumanRound.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "human-kit-deliveries":
      HireHumanKitDelivery.collection as unknown as HireCandidateWorkspaceIndexCollection,
    "external-verdicts":
      HireExternalVerdict.collection as unknown as HireCandidateWorkspaceIndexCollection,
  };
}

async function readIndexes(
  collections: HireCandidateWorkspaceIndexDependencies["collections"],
): Promise<
  Record<HireCandidateWorkspaceIndexTarget, HireCandidateWorkspaceIndexDescription[]>
> {
  const result = {} as Record<
    HireCandidateWorkspaceIndexTarget,
    HireCandidateWorkspaceIndexDescription[]
  >;
  await Promise.all(
    INDEX_TARGETS.map(async (target) => {
      try {
        result[target] = await collections[target].indexes();
      } catch (error) {
        if (!namespaceMissing(error)) throw error;
        result[target] = [];
      }
    }),
  );
  return result;
}

const UNIQUE_CHECKS: readonly {
  target: HireCandidateWorkspaceIndexTarget;
  label: string;
  pipeline: unknown[];
}[] = [
  {
    target: "candidate-bulk-operations",
    label: "workspace/member/client-operation bulk rows",
    pipeline: [
      { $match: { privacyRedactedAt: { $exists: false } } },
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            requestedByMemberId: "$requestedByMemberId",
            clientOperationId: "$clientOperationId",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "candidate-bulk-operation-items",
    label: "workspace/operation/application bulk items",
    pipeline: [
      { $match: { privacyRedactedAt: { $exists: false } } },
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            bulkOperationId: "$bulkOperationId",
            applicationId: "$applicationId",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
];

async function assertUniqueData(
  collections: HireCandidateWorkspaceIndexDependencies["collections"],
): Promise<void> {
  for (const check of UNIQUE_CHECKS) {
    try {
      const duplicates = await collections[check.target]
        .aggregate<{ _id: unknown; count: number }>(check.pipeline)
        .toArray();
      if (duplicates.length) {
        throw new Error(`duplicate ${check.label}; no index was changed`);
      }
    } catch (error) {
      if (!namespaceMissing(error)) throw error;
    }
  }
}

function assertHireControlBoundary(connection: unknown): void {
  if (process.env.IPG_SURFACE !== "hire-control") {
    throw new Error("IPG_SURFACE must be hire-control");
  }
  const expected = process.env.HIRE_CONTROL_DATABASE_NAME?.trim();
  const actual = (connection as { connection?: { name?: unknown } })?.connection?.name;
  if (!expected || expected !== actual) {
    throw new Error("connected database is not the configured Hire control database");
  }
}

function printDefinitions(): void {
  console.log("\nHire candidate-workspace index preparation");
  for (const definition of HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS) {
    const options = [
      definition.unique ? "UNIQUE" : "",
      definition.expireAfterSeconds !== undefined
        ? `TTL ${definition.expireAfterSeconds}s`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${
        options ? ` ${options}` : ""
      } — ${definition.purpose}`,
    );
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-candidate-workspace-indexes
  npm run check:hire-candidate-workspace-indexes
  npm run prepare:hire-candidate-workspace-indexes -- --apply

The default plan is disconnected. --check never writes. --apply creates only
missing exact indexes and never invokes dropIndex, syncIndexes, or autoIndex.
`);
}

export async function prepareHireCandidateWorkspaceIndexes(
  argv: string[],
  dependencies?: HireCandidateWorkspaceIndexDependencies,
): Promise<void> {
  const mode = hireCandidateWorkspaceIndexModeOf(argv);
  if (mode === "help") {
    printUsage();
    return;
  }
  printDefinitions();
  if (mode === "plan") {
    console.log("\nPLAN ONLY — no database connection or index write.");
    return;
  }

  const runtime =
    dependencies ??
    ({
      connect: () => connectDB({ schemaInitialization: "disabled" }),
      collections: defaultCollections(),
    } satisfies HireCandidateWorkspaceIndexDependencies);
  const connection = await runtime.connect();
  assertHireControlBoundary(connection);
  const before = inspect(await readIndexes(runtime.collections));

  if (mode === "check") {
    assertExact(before);
    console.log(
      `\nCHECK PASSED — all ${HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.length} exact indexes exist.`,
    );
    return;
  }

  assertCompatible(before);
  await assertUniqueData(runtime.collections);
  for (const { definition } of missing(before)) {
    const indexName = await runtime.collections[definition.target].createIndex(
      definition.key,
      {
        name: definition.name,
        ...(definition.unique ? { unique: true } : {}),
        ...(definition.expireAfterSeconds !== undefined
          ? { expireAfterSeconds: definition.expireAfterSeconds }
          : {}),
        ...(definition.partialFilterExpression
          ? { partialFilterExpression: definition.partialFilterExpression }
          : {}),
      },
    );
    console.log(`Prepared ${definition.target}.${indexName}`);
  }
  assertExact(inspect(await readIndexes(runtime.collections)));
  console.log(
    `\nAPPLY PASSED — all ${HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.length} exact indexes exist; none were removed.`,
  );
}

async function main(): Promise<void> {
  await prepareHireCandidateWorkspaceIndexes(process.argv.slice(2));
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Hire candidate-workspace index preparation failed:", error);
      process.exit(1);
    });
}
