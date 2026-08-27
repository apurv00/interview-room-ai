import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS,
  hireCandidateWorkspaceIndexModeOf,
  isExactHireCandidateWorkspaceIndex,
  prepareHireCandidateWorkspaceIndexes,
  type HireCandidateWorkspaceIndexDependencies,
  type HireCandidateWorkspaceIndexTarget,
} from "../prepare-hire-candidate-workspace-indexes";

type CollectionMocks = {
  createIndex: ReturnType<typeof vi.fn>;
  indexes: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  duplicateRows: ReturnType<typeof vi.fn>;
};

function exactIndexes(target: HireCandidateWorkspaceIndexTarget) {
  return HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.filter(
    (definition) => definition.target === target,
  ).map((definition) => ({
    name: definition.name,
    key: definition.key,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.expireAfterSeconds !== undefined
      ? { expireAfterSeconds: definition.expireAfterSeconds }
      : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
  }));
}

function runtimeFixture(): {
  dependencies: HireCandidateWorkspaceIndexDependencies;
  connect: ReturnType<typeof vi.fn>;
  collections: Record<HireCandidateWorkspaceIndexTarget, CollectionMocks>;
} {
  const targets = Array.from(
    new Set(HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.map(({ target }) => target)),
  );
  const collections = {} as Record<
    HireCandidateWorkspaceIndexTarget,
    CollectionMocks
  >;
  for (const target of targets) {
    const duplicateRows = vi.fn().mockResolvedValue([]);
    collections[target] = {
      createIndex: vi.fn().mockImplementation(async (_key, options) => options.name),
      indexes: vi.fn(),
      aggregate: vi.fn(() => ({ toArray: duplicateRows })),
      duplicateRows,
    };
  }
  const connect = vi
    .fn()
    .mockResolvedValue({ connection: { name: "hire-control-test" } });
  return {
    connect,
    collections,
    dependencies: {
      connect,
      collections: collections as unknown as HireCandidateWorkspaceIndexDependencies["collections"],
    },
  };
}

function setExact(fixture: ReturnType<typeof runtimeFixture>): void {
  for (const [target, collection] of Object.entries(fixture.collections)) {
    collection.indexes.mockResolvedValue(
      exactIndexes(target as HireCandidateWorkspaceIndexTarget),
    );
  }
}

function setMissingThenExact(fixture: ReturnType<typeof runtimeFixture>): void {
  for (const [target, collection] of Object.entries(fixture.collections)) {
    collection.indexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(exactIndexes(target as HireCandidateWorkspaceIndexTarget));
  }
}

describe("Hire candidate-workspace index preparation", () => {
  const originalSurface = process.env.IPG_SURFACE;
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME;

  beforeEach(() => {
    process.env.IPG_SURFACE = "hire-control";
    process.env.HIRE_CONTROL_DATABASE_NAME = "hire-control-test";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalSurface === undefined) delete process.env.IPG_SURFACE;
    else process.env.IPG_SURFACE = originalSurface;
    if (originalDatabase === undefined) delete process.env.HIRE_CONTROL_DATABASE_NAME;
    else process.env.HIRE_CONTROL_DATABASE_NAME = originalDatabase;
    vi.restoreAllMocks();
  });

  it("defaults to a disconnected plan and rejects ambiguous or destructive flags", async () => {
    const fixture = runtimeFixture();
    expect(hireCandidateWorkspaceIndexModeOf([])).toBe("plan");
    expect(hireCandidateWorkspaceIndexModeOf(["--check"])).toBe("check");
    expect(hireCandidateWorkspaceIndexModeOf(["--apply"])).toBe("apply");
    expect(() =>
      hireCandidateWorkspaceIndexModeOf(["--check", "--apply"]),
    ).toThrow("mutually exclusive");
    expect(() => hireCandidateWorkspaceIndexModeOf(["--drop"])).toThrow(
      "unknown argument",
    );

    await prepareHireCandidateWorkspaceIndexes([], fixture.dependencies);

    expect(fixture.connect).not.toHaveBeenCalled();
    for (const collection of Object.values(fixture.collections)) {
      expect(collection.indexes).not.toHaveBeenCalled();
      expect(collection.createIndex).not.toHaveBeenCalled();
      expect(collection.aggregate).not.toHaveBeenCalled();
    }
  });

  it("keeps check mode read-only and requires every exact option", async () => {
    const fixture = runtimeFixture();
    setExact(fixture);

    await prepareHireCandidateWorkspaceIndexes(["--check"], fixture.dependencies);

    expect(fixture.connect).toHaveBeenCalledTimes(1);
    for (const collection of Object.values(fixture.collections)) {
      expect(collection.indexes).toHaveBeenCalledTimes(1);
      expect(collection.createIndex).not.toHaveBeenCalled();
      expect(collection.aggregate).not.toHaveBeenCalled();
    }
  });

  it("preflights both unique bulk invariants before creating only missing indexes", async () => {
    const fixture = runtimeFixture();
    setMissingThenExact(fixture);

    await prepareHireCandidateWorkspaceIndexes(["--apply"], fixture.dependencies);

    expect(fixture.collections["candidate-bulk-operations"].aggregate).toHaveBeenCalledTimes(1);
    expect(
      fixture.collections["candidate-bulk-operation-items"].aggregate,
    ).toHaveBeenCalledTimes(1);
    const writes = Object.values(fixture.collections).reduce(
      (count, collection) => count + collection.createIndex.mock.calls.length,
      0,
    );
    expect(writes).toBe(HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.length);
    expect(
      fixture.collections["candidate-selections"].createIndex,
    ).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { name: "expiresAt_1", expireAfterSeconds: 0 },
    );
  });

  it("excludes multiple privacy-redacted bulk items from the live uniqueness preflight", async () => {
    const fixture = runtimeFixture();
    setMissingThenExact(fixture);
    const collection = fixture.collections["candidate-bulk-operation-items"];
    collection.aggregate.mockImplementation((pipeline: unknown[]) => ({
      toArray: vi.fn().mockResolvedValue(
        (pipeline[0] as { $match?: unknown })?.$match
          ? []
          : [
              {
                _id: {
                  workspaceId: "w",
                  bulkOperationId: "o",
                  applicationId: null,
                },
                count: 2,
              },
            ],
      ),
    }));

    await prepareHireCandidateWorkspaceIndexes(["--apply"], fixture.dependencies);

    expect(collection.aggregate).toHaveBeenCalledWith([
      { $match: { privacyRedactedAt: { $exists: false } } },
      expect.objectContaining({ $group: expect.any(Object) }),
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]);
    expect(collection.createIndex).toHaveBeenCalledWith(
      { workspaceId: 1, bulkOperationId: 1, applicationId: 1 },
      expect.objectContaining({
        name: "hire_candidate_bulk_item_application_unique",
        partialFilterExpression: { privacyRedactedAt: { $exists: false } },
        unique: true,
      }),
    );
  });

  it("fails on a conflicting name before a unique preflight or any write", async () => {
    const fixture = runtimeFixture();
    setExact(fixture);
    const exactApplicationIndexes = exactIndexes("applications");
    fixture.collections.applications.indexes.mockResolvedValue([
      ...exactApplicationIndexes.filter(
        (index) => index.name !== "hire_candidate_workspace_job_snapshot_read",
      ),
      {
        name: "hire_candidate_workspace_job_snapshot_read",
        key: { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
      },
    ]);

    await expect(
      prepareHireCandidateWorkspaceIndexes(["--apply"], fixture.dependencies),
    ).rejects.toThrow("incompatible candidate-workspace index name/key");

    for (const collection of Object.values(fixture.collections)) {
      expect(collection.aggregate).not.toHaveBeenCalled();
      expect(collection.createIndex).not.toHaveBeenCalled();
    }
  });

  it("fails all writes when existing data violates a unique bulk invariant", async () => {
    const fixture = runtimeFixture();
    setMissingThenExact(fixture);
    fixture.collections["candidate-bulk-operations"].duplicateRows.mockResolvedValue([
      { _id: { workspaceId: "w", requestedByMemberId: "m", clientOperationId: "x" }, count: 2 },
    ]);

    await expect(
      prepareHireCandidateWorkspaceIndexes(["--apply"], fixture.dependencies),
    ).rejects.toThrow("duplicate workspace/member/client-operation bulk rows");

    for (const collection of Object.values(fixture.collections)) {
      expect(collection.createIndex).not.toHaveBeenCalled();
    }
  });

  it("plans snapshot, retained bulk, and decision indexes explicitly", () => {
    expect(HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS).toHaveLength(19);
    const byTarget = (target: HireCandidateWorkspaceIndexTarget) =>
      HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === target,
      );
    expect(byTarget("candidate-selections")).toHaveLength(2);
    expect(byTarget("candidate-bulk-operations")).toHaveLength(4);
    expect(byTarget("candidate-bulk-operation-items")).toHaveLength(5);
    expect(byTarget("human-rounds")).toHaveLength(1);
    expect(byTarget("human-kit-deliveries")).toHaveLength(1);
    expect(byTarget("external-verdicts")).toHaveLength(1);
    const inventory = Object.fromEntries(
      HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.map((definition) => [
        definition.name,
        definition,
      ]),
    );
    expect(inventory).toMatchObject({
      workspaceId_1_jobId_1_invitationBatchId_1__id_1: {
        target: "invitation-batch-items",
        key: { workspaceId: 1, jobId: 1, invitationBatchId: 1, _id: 1 },
        unique: false,
      },
      workspaceId_1_jobId_1_memberId_1_expiresAt_1__id_1: {
        target: "candidate-selections",
        key: { workspaceId: 1, jobId: 1, memberId: 1, expiresAt: 1, _id: 1 },
        unique: false,
      },
      expiresAt_1: {
        target: "candidate-selections",
        key: { expiresAt: 1 },
        unique: false,
        expireAfterSeconds: 0,
      },
      hire_candidate_bulk_operation_member_idempotency_unique: {
        key: { workspaceId: 1, requestedByMemberId: 1, clientOperationId: 1 },
        unique: true,
      },
      hire_candidate_bulk_operation_recovery: {
        key: {
          workspaceId: 1,
          status: 1,
          nextRecoveryAt: 1,
          updatedAt: 1,
          _id: 1,
        },
        unique: false,
      },
      hire_candidate_bulk_operation_job_history: {
        key: { workspaceId: 1, jobId: 1, createdAt: -1, _id: -1 },
        unique: false,
      },
      hire_candidate_bulk_item_application_unique: {
        key: { workspaceId: 1, bulkOperationId: 1, applicationId: 1 },
        unique: true,
        partialFilterExpression: { privacyRedactedAt: { $exists: false } },
      },
      hire_candidate_bulk_item_claim: {
        key: {
          workspaceId: 1,
          bulkOperationId: 1,
          status: 1,
          nextAttemptAt: 1,
          _id: 1,
        },
        unique: false,
      },
      hire_candidate_bulk_item_lease_recovery: {
        key: {
          workspaceId: 1,
          bulkOperationId: 1,
          status: 1,
          leaseExpiresAt: 1,
          _id: 1,
        },
        unique: false,
      },
      hire_candidate_bulk_item_issue_page: {
        key: { workspaceId: 1, bulkOperationId: 1, status: 1, _id: 1 },
        unique: false,
      },
    });
  });

  it("accepts the pre-existing Phase-2 recipient-ledger index identity", async () => {
    const fixture = runtimeFixture();
    setExact(fixture);
    fixture.collections["invitation-batch-items"].indexes.mockResolvedValue(
      exactIndexes("invitation-batch-items"),
    );

    await expect(
      prepareHireCandidateWorkspaceIndexes(["--check"], fixture.dependencies),
    ).resolves.toBeUndefined();
    expect(
      fixture.collections["invitation-batch-items"].createIndex,
    ).not.toHaveBeenCalled();
    expect(
      exactIndexes("invitation-batch-items"),
    ).toContainEqual({
      name: "workspaceId_1_jobId_1_invitationBatchId_1__id_1",
      key: { workspaceId: 1, jobId: 1, invitationBatchId: 1, _id: 1 },
    });
  });

  it("does not accept a TTL key whose expiration option is absent", () => {
    const definition = HIRE_CANDIDATE_WORKSPACE_INDEX_DEFINITIONS.find(
      ({ target, name }) => target === "candidate-selections" && name === "expiresAt_1",
    )!;
    expect(
      isExactHireCandidateWorkspaceIndex(
        { name: definition.name, key: definition.key },
        definition,
      ),
    ).toBe(false);
  });

  it("refuses a connected database outside the configured Hire-control name", async () => {
    const fixture = runtimeFixture();
    setExact(fixture);
    fixture.connect.mockResolvedValue({ connection: { name: "wrong" } });

    await expect(
      prepareHireCandidateWorkspaceIndexes(["--check"], fixture.dependencies),
    ).rejects.toThrow("configured Hire control database");
    for (const collection of Object.values(fixture.collections)) {
      expect(collection.indexes).not.toHaveBeenCalled();
    }
  });
});
