#!/usr/bin/env tsx
/**
 * Explicit, non-dropping Hire Phase 5 member-operations index preparation.
 *
 *   npm run prepare:hire-phase5-indexes              # plan only; no DB connection
 *   npm run check:hire-phase5-indexes                # connected, read-only verification
 *   npm run prepare:hire-phase5-indexes -- --apply   # create only missing exact indexes
 *
 * This covers only schema-declared indexes on the new Phase 5 status,
 * report, digest, and onboarding collections. Operations is a read model and
 * deliberately contributes no speculative indexes here. This script never
 * calls syncIndexes, dropIndex, or any bulk index mutation.
 */

import { pathToFileURL } from "node:url";
import { connectDB } from "../shared/db/connection";
import { HireCandidateStatusLink } from "../modules/hire-status/models";
import {
  HireReportExport,
  HireReportExportCleanup,
} from "../modules/hire-reports/models";
import {
  HireDigestOutbox,
  HireDigestPreference,
} from "../modules/hire-digest/models";
import { HireOnboardingTestDrive } from "../modules/hire-onboarding/models";

export type HirePhase5IndexPreparationMode =
  "plan" | "check" | "apply" | "help";

type IndexDirection = 1 | -1;
type IndexKey = Readonly<Record<string, IndexDirection>>;
type PartialFilterExpression = Readonly<Record<string, unknown>>;
type IndexTarget =
  | "candidate-status-links"
  | "report-exports"
  | "report-export-cleanups"
  | "digest-preferences"
  | "digest-outboxes"
  | "onboarding-test-drives";

export interface HirePhase5IndexDescription {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: number;
  sparse?: boolean;
  hidden?: boolean;
  collation?: unknown;
}

export interface HirePhase5IndexDefinition {
  target: IndexTarget;
  name: string;
  key: IndexKey;
  unique: boolean;
  partialFilterExpression?: PartialFilterExpression;
  purpose: string;
}

interface IndexCollection {
  createIndex(
    key: IndexKey,
    options: {
      name: string;
      unique?: boolean;
      partialFilterExpression?: PartialFilterExpression;
    },
  ): Promise<string>;
  indexes(): Promise<HirePhase5IndexDescription[]>;
  aggregate<T>(pipeline: unknown[]): { toArray(): Promise<T[]> };
}

/** These names exactly match the new Phase 5 model schema declarations. */
export const HIRE_PHASE5_INDEX_DEFINITIONS: readonly HirePhase5IndexDefinition[] =
  [
    {
      target: "candidate-status-links",
      name: "workspaceId_1_applicationId_1_issuanceOperationId_1",
      key: { workspaceId: 1, applicationId: 1, issuanceOperationId: 1 },
      unique: true,
      purpose: "workspace-scoped status-link issuance idempotency",
    },
    {
      target: "candidate-status-links",
      name: "workspaceId_1_applicationId_1_active_1_expiresAt_1",
      key: { workspaceId: 1, applicationId: 1, active: 1, expiresAt: 1 },
      unique: false,
      purpose: "member application listing, revocation, and expiry lookup",
    },
    {
      target: "candidate-status-links",
      name: "workspaceId_1_candidateId_1_active_1_expiresAt_1",
      key: { workspaceId: 1, candidateId: 1, active: 1, expiresAt: 1 },
      unique: false,
      purpose: "candidate privacy and retention status-link lookup",
    },
    {
      target: "report-exports",
      name: "workspaceId_1_creationOperationId_1",
      key: { workspaceId: 1, creationOperationId: 1 },
      unique: true,
      purpose: "workspace-scoped report request idempotency",
    },
    {
      target: "report-exports",
      name: "workspaceId_1_jobId_1_createdAt_-1",
      key: { workspaceId: 1, jobId: 1, createdAt: -1 },
      unique: false,
      purpose: "member job-scoped report history",
    },
    {
      target: "report-exports",
      name: "workspaceId_1_status_1_nextRetryAt_1_leaseExpiresAt_1_expiresAt_1",
      key: {
        workspaceId: 1,
        status: 1,
        nextRetryAt: 1,
        leaseExpiresAt: 1,
        expiresAt: 1,
      },
      unique: false,
      purpose: "tenant-fair report recovery, lease, retry, and expiry sweep",
    },
    {
      target: "report-exports",
      name: "workspaceId_1_reportKind_1_status_1_createdAt_-1",
      key: { workspaceId: 1, reportKind: 1, status: 1, createdAt: -1 },
      unique: false,
      purpose: "report-kind lifecycle and member status history",
    },
    {
      target: "report-exports",
      name: "workspaceId_1_affectedCandidateIds_1_status_1",
      key: { workspaceId: 1, affectedCandidateIds: 1, status: 1 },
      unique: false,
      purpose: "candidate privacy cancellation and private-artifact cleanup",
    },
    {
      target: "report-export-cleanups",
      name: "workspaceId_1_exportId_1",
      key: { workspaceId: 1, exportId: 1 },
      unique: true,
      purpose: "one durable private-object cleanup obligation per report",
    },
    {
      target: "report-export-cleanups",
      name: "firstSweepAt_1_nextRetryAt_1_cleanupNotBeforeAt_1_leaseExpiresAt_1__id_1",
      key: {
        firstSweepAt: 1,
        nextRetryAt: 1,
        cleanupNotBeforeAt: 1,
        leaseExpiresAt: 1,
        _id: 1,
      },
      unique: false,
      purpose:
        "global private-object cleanup recovery after workspace deletion",
    },
    {
      target: "digest-preferences",
      name: "workspaceId_1_memberId_1",
      key: { workspaceId: 1, memberId: 1 },
      unique: true,
      purpose: "one explicit digest preference per workspace member",
    },
    {
      target: "digest-preferences",
      name: "workspaceId_1_enabled_1_updatedAt_1",
      key: { workspaceId: 1, enabled: 1, updatedAt: 1 },
      unique: false,
      purpose: "workspace-scoped opt-in recipient enumeration",
    },
    {
      target: "digest-outboxes",
      name: "workspaceId_1_memberId_1_periodKey_1",
      key: { workspaceId: 1, memberId: 1, periodKey: 1 },
      unique: true,
      purpose: "one scheduled digest outbox row per member and UTC period",
    },
    {
      target: "digest-outboxes",
      name: "workspaceId_1_status_1_sendAfter_1_leaseExpiresAt_1__id_1",
      key: {
        workspaceId: 1,
        status: 1,
        sendAfter: 1,
        leaseExpiresAt: 1,
        _id: 1,
      },
      unique: false,
      purpose: "tenant-fair due-digest claim and lease recovery",
    },
    {
      target: "digest-outboxes",
      name: "workspaceId_1_memberId_1_status_1",
      key: { workspaceId: 1, memberId: 1, status: 1 },
      unique: false,
      purpose: "member opt-out cancellation of pending digest deliveries",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_issuedByMemberId_1_operationId_1",
      key: { workspaceId: 1, issuedByMemberId: 1, operationId: 1 },
      unique: true,
      purpose: "workspace-member test-drive create idempotency",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_issuedByMemberId_1_active_1",
      key: { workspaceId: 1, issuedByMemberId: 1, active: 1 },
      unique: true,
      partialFilterExpression: { active: true },
      purpose: "at most one active synthetic test drive per workspace member",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_cleanupAfter_1_state_1",
      key: { workspaceId: 1, cleanupAfter: 1, state: 1 },
      unique: false,
      purpose: "bounded lifecycle cleanup of synthetic test-drive graphs",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_applicationId_1_excludeFromAggregates_1",
      key: { workspaceId: 1, applicationId: 1, excludeFromAggregates: 1 },
      unique: false,
      purpose: "application aggregate exclusion join",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_jobId_1_excludeFromAggregates_1",
      key: { workspaceId: 1, jobId: 1, excludeFromAggregates: 1 },
      unique: false,
      purpose: "job aggregate exclusion join",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_candidateId_1_excludeFromAggregates_1",
      key: { workspaceId: 1, candidateId: 1, excludeFromAggregates: 1 },
      unique: false,
      purpose: "candidate aggregate exclusion join",
    },
    {
      target: "onboarding-test-drives",
      name: "workspaceId_1_roundId_1_excludeFromAggregates_1",
      key: { workspaceId: 1, roundId: 1, excludeFromAggregates: 1 },
      unique: false,
      purpose: "round aggregate exclusion join",
    },
  ];

function isNamespaceNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === 26 ||
      (error as { codeName?: unknown }).codeName === "NamespaceNotFound")
  );
}

export function hirePhase5IndexPreparationModeOf(
  argv: string[],
): HirePhase5IndexPreparationMode {
  const supported = new Set(["--apply", "--check", "--help", "-h"]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length) {
    throw new Error(
      `unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
  const help = argv.includes("--help") || argv.includes("-h");
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  if (help && argv.length > 1) {
    throw new Error("--help cannot be combined with another argument");
  }
  if (apply && check)
    throw new Error("--apply and --check are mutually exclusive");
  if (help) return "help";
  return apply ? "apply" : check ? "check" : "plan";
}

function sameKey(
  actual: Record<string, unknown> | undefined,
  expected: IndexKey,
): boolean {
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

function samePartialFilter(
  actual: unknown,
  expected: PartialFilterExpression | undefined,
): boolean {
  if (actual === undefined || expected === undefined)
    return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function isExactHirePhase5Index(
  index: HirePhase5IndexDescription,
  definition: HirePhase5IndexDefinition,
): boolean {
  return (
    index.name === definition.name &&
    sameKey(index.key, definition.key) &&
    Boolean(index.unique) === definition.unique &&
    samePartialFilter(
      index.partialFilterExpression,
      definition.partialFilterExpression,
    ) &&
    index.expireAfterSeconds === undefined &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation === undefined
  );
}

interface IndexInspection {
  definition: HirePhase5IndexDefinition;
  exact: boolean;
  sameKeyIndexes: HirePhase5IndexDescription[];
}

type IndexesByTarget = Record<IndexTarget, HirePhase5IndexDescription[]>;

function inspectIndexes(indexesByTarget: IndexesByTarget): IndexInspection[] {
  return HIRE_PHASE5_INDEX_DEFINITIONS.map((definition) => {
    const sameKeyIndexes = indexesByTarget[definition.target].filter((index) =>
      sameKey(index.key, definition.key),
    );
    return {
      definition,
      sameKeyIndexes,
      exact:
        sameKeyIndexes.length === 1 &&
        isExactHirePhase5Index(sameKeyIndexes[0], definition),
    };
  });
}

function missingIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length === 0,
  );
}

function incompatibleIndexes(inspection: IndexInspection[]): IndexInspection[] {
  return inspection.filter(
    ({ exact, sameKeyIndexes }) => !exact && sameKeyIndexes.length > 0,
  );
}

function describeIndex(index: HirePhase5IndexDescription): string {
  return `${index.name ?? "<unnamed>"} ${JSON.stringify(index.key ?? {})}`;
}

function assertNoIncompatibleIndexes(inspection: IndexInspection[]): void {
  const incompatible = incompatibleIndexes(inspection);
  if (incompatible.length) {
    throw new Error(
      `incompatible same-key Phase 5 index(es): ${incompatible
        .map(
          ({ definition, sameKeyIndexes }) =>
            `${definition.target}.${definition.name} <- ${sameKeyIndexes
              .map(describeIndex)
              .join(", ")}`,
        )
        .join(
          "; ",
        )}. No index was changed; explicit operator repair is required.`,
    );
  }
}

function assertEveryIndexExact(inspection: IndexInspection[]): void {
  assertNoIncompatibleIndexes(inspection);
  const missing = missingIndexes(inspection);
  if (missing.length) {
    throw new Error(
      `missing exact Phase 5 Hire-control index(es): ${missing
        .map(({ definition }) => `${definition.target}.${definition.name}`)
        .join(", ")}`,
    );
  }
}

function formatDefinitions(): void {
  console.log("\nHire Phase 5 member-operations index preparation");
  console.log("────────────────────────────────────────────────");
  for (const definition of HIRE_PHASE5_INDEX_DEFINITIONS) {
    const options = [
      definition.unique ? "UNIQUE" : "",
      definition.partialFilterExpression
        ? `PARTIAL ${JSON.stringify(definition.partialFilterExpression)}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${definition.target}.${definition.name}: ${JSON.stringify(definition.key)}${options ? ` ${options}` : ""} — ${definition.purpose}`,
    );
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run prepare:hire-phase5-indexes
  npm run check:hire-phase5-indexes
  npm run prepare:hire-phase5-indexes -- --apply

Modes:
  (default)  print the exact Phase 5 Hire-control index plan; no database connection
  --check    connect read-only and require every exact index
  --apply    create only missing exact indexes after all preconditions pass

Safety:
  --apply never invokes dropIndex, syncIndexes, or a bulk index mutation. It
  stops before any write when a same-key index is incompatible or duplicate
  rows would violate a unique invariant. Operations has no speculative index.
`);
}

function assertHireControlDatabaseBoundary(connection: unknown): void {
  if (process.env.IPG_SURFACE !== "hire-control") {
    throw new Error("IPG_SURFACE must be hire-control");
  }
  const expectedDatabase = process.env.HIRE_CONTROL_DATABASE_NAME?.trim();
  const actualDatabase = (connection as { connection?: { name?: unknown } })
    ?.connection?.name;
  if (!expectedDatabase || actualDatabase !== expectedDatabase) {
    throw new Error(
      "connected database is not the configured Hire control database",
    );
  }
}

function collectionsByTarget(): Record<IndexTarget, IndexCollection> {
  return {
    "candidate-status-links":
      HireCandidateStatusLink.collection as unknown as IndexCollection,
    "report-exports": HireReportExport.collection as unknown as IndexCollection,
    "report-export-cleanups":
      HireReportExportCleanup.collection as unknown as IndexCollection,
    "digest-preferences":
      HireDigestPreference.collection as unknown as IndexCollection,
    "digest-outboxes":
      HireDigestOutbox.collection as unknown as IndexCollection,
    "onboarding-test-drives":
      HireOnboardingTestDrive.collection as unknown as IndexCollection,
  };
}

const INDEX_TARGETS: readonly IndexTarget[] = [
  "candidate-status-links",
  "report-exports",
  "report-export-cleanups",
  "digest-preferences",
  "digest-outboxes",
  "onboarding-test-drives",
];

async function readIndexes(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<IndexesByTarget> {
  const result = {} as IndexesByTarget;
  await Promise.all(
    INDEX_TARGETS.map(async (target) => {
      try {
        result[target] = await collections[target].indexes();
      } catch (error) {
        // First rollout may not have materialized a collection. It is simply
        // missing all of its indexes until --apply creates the first one.
        if (!isNamespaceNotFoundError(error)) throw error;
        result[target] = [];
      }
    }),
  );
  return result;
}

function reportInspection(inspection: IndexInspection[]): void {
  console.log("\nInspection");
  for (const entry of inspection) {
    if (entry.exact) {
      console.log(`✓ ${entry.definition.target}.${entry.definition.name}`);
    } else if (entry.sameKeyIndexes.length === 0) {
      console.log(
        `○ ${entry.definition.target}.${entry.definition.name} is missing`,
      );
    } else {
      console.log(
        `! ${entry.definition.target}.${entry.definition.name} has incompatible same-key index(es): ${entry.sameKeyIndexes.map(describeIndex).join("; ")}`,
      );
    }
  }
}

interface UniqueIndexDuplicateCheck {
  target: IndexTarget;
  label: string;
  pipeline: unknown[];
}

const UNIQUE_INDEX_DUPLICATE_CHECKS: readonly UniqueIndexDuplicateCheck[] = [
  {
    target: "candidate-status-links",
    label: "workspace/application/status-link issuance rows",
    pipeline: [
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            applicationId: "$applicationId",
            issuanceOperationId: "$issuanceOperationId",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "report-exports",
    label: "workspace/creation operation report-export rows",
    pipeline: [
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            creationOperationId: "$creationOperationId",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "report-export-cleanups",
    label: "workspace/export report-cleanup tombstones",
    pipeline: [
      {
        $group: {
          _id: { workspaceId: "$workspaceId", exportId: "$exportId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "digest-preferences",
    label: "workspace/member digest-preference rows",
    pipeline: [
      {
        $group: {
          _id: { workspaceId: "$workspaceId", memberId: "$memberId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "digest-outboxes",
    label: "workspace/member/period digest-outbox rows",
    pipeline: [
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            memberId: "$memberId",
            periodKey: "$periodKey",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "onboarding-test-drives",
    label: "workspace/member/test-drive operation rows",
    pipeline: [
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            issuedByMemberId: "$issuedByMemberId",
            operationId: "$operationId",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
  {
    target: "onboarding-test-drives",
    label: "workspace/member active test-drive rows",
    pipeline: [
      { $match: { active: true } },
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            issuedByMemberId: "$issuedByMemberId",
            active: "$active",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ],
  },
];

async function assertNoUniqueIndexDuplicates(
  collections: Record<IndexTarget, IndexCollection>,
): Promise<void> {
  for (const check of UNIQUE_INDEX_DUPLICATE_CHECKS) {
    try {
      const duplicates = await collections[check.target]
        .aggregate<{ _id: unknown; count: number }>(check.pipeline)
        .toArray();
      if (duplicates.length) {
        throw new Error(
          `duplicate ${check.label} block the Phase 5 unique index; no index was changed`,
        );
      }
    } catch (error) {
      if (isNamespaceNotFoundError(error)) continue;
      throw error;
    }
  }
}

function createOptions(definition: HirePhase5IndexDefinition): {
  name: string;
  unique?: boolean;
  partialFilterExpression?: PartialFilterExpression;
} {
  return {
    name: definition.name,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
  };
}

export async function prepareHirePhase5Indexes(argv: string[]): Promise<void> {
  const mode = hirePhase5IndexPreparationModeOf(argv);
  if (mode === "help") {
    printUsage();
    return;
  }
  formatDefinitions();
  if (mode === "plan") {
    console.log(
      "\nPLAN ONLY — no database connection or index write. Re-run with --check or --apply.",
    );
    return;
  }

  // Suppress Mongoose automatic index initialization. The only possible write
  // is the exact createIndex call below, after a complete preflight.
  const connection = await connectDB({ schemaInitialization: "disabled" });
  assertHireControlDatabaseBoundary(connection);
  const collections = collectionsByTarget();
  const before = inspectIndexes(await readIndexes(collections));
  reportInspection(before);

  if (mode === "check") {
    assertEveryIndexExact(before);
    console.log(
      `\nCHECK PASSED — all ${HIRE_PHASE5_INDEX_DEFINITIONS.length} exact Phase 5 Hire-control indexes exist.`,
    );
    return;
  }

  assertNoIncompatibleIndexes(before);
  await assertNoUniqueIndexDuplicates(collections);
  for (const { definition } of missingIndexes(before)) {
    const indexName = await collections[definition.target].createIndex(
      definition.key,
      createOptions(definition),
    );
    console.log(`Prepared ${definition.target}.${indexName}`);
  }
  const after = inspectIndexes(await readIndexes(collections));
  assertEveryIndexExact(after);
  console.log(
    `\nAPPLY PASSED — all ${HIRE_PHASE5_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
  );
}

async function main(): Promise<void> {
  await prepareHirePhase5Indexes(process.argv.slice(2));
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Hire Phase 5 index preparation failed:", error);
      process.exit(1);
    });
}
