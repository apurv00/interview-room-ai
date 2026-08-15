import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  statusCreateIndex: vi.fn(),
  statusIndexes: vi.fn(),
  statusAggregate: vi.fn(),
  statusDuplicateRows: vi.fn(),
  reportCreateIndex: vi.fn(),
  reportIndexes: vi.fn(),
  reportAggregate: vi.fn(),
  reportDuplicateRows: vi.fn(),
  cleanupCreateIndex: vi.fn(),
  cleanupIndexes: vi.fn(),
  cleanupAggregate: vi.fn(),
  cleanupDuplicateRows: vi.fn(),
  preferenceCreateIndex: vi.fn(),
  preferenceIndexes: vi.fn(),
  preferenceAggregate: vi.fn(),
  preferenceDuplicateRows: vi.fn(),
  outboxCreateIndex: vi.fn(),
  outboxIndexes: vi.fn(),
  outboxAggregate: vi.fn(),
  outboxDuplicateRows: vi.fn(),
  onboardingCreateIndex: vi.fn(),
  onboardingIndexes: vi.fn(),
  onboardingAggregate: vi.fn(),
  onboardingDuplicateRows: vi.fn(),
}));

vi.mock("../../shared/db/connection", () => ({ connectDB: mocks.connectDB }));
vi.mock("../../modules/hire-status/models", () => ({
  HireCandidateStatusLink: {
    collection: {
      createIndex: mocks.statusCreateIndex,
      indexes: mocks.statusIndexes,
      aggregate: mocks.statusAggregate,
    },
  },
}));
vi.mock("../../modules/hire-reports/models", () => ({
  HireReportExport: {
    collection: {
      createIndex: mocks.reportCreateIndex,
      indexes: mocks.reportIndexes,
      aggregate: mocks.reportAggregate,
    },
  },
  HireReportExportCleanup: {
    collection: {
      createIndex: mocks.cleanupCreateIndex,
      indexes: mocks.cleanupIndexes,
      aggregate: mocks.cleanupAggregate,
    },
  },
}));
vi.mock("../../modules/hire-digest/models", () => ({
  HireDigestPreference: {
    collection: {
      createIndex: mocks.preferenceCreateIndex,
      indexes: mocks.preferenceIndexes,
      aggregate: mocks.preferenceAggregate,
    },
  },
  HireDigestOutbox: {
    collection: {
      createIndex: mocks.outboxCreateIndex,
      indexes: mocks.outboxIndexes,
      aggregate: mocks.outboxAggregate,
    },
  },
}));
vi.mock("../../modules/hire-onboarding/models", () => ({
  HireOnboardingTestDrive: {
    collection: {
      createIndex: mocks.onboardingCreateIndex,
      indexes: mocks.onboardingIndexes,
      aggregate: mocks.onboardingAggregate,
    },
  },
}));

import {
  HIRE_PHASE5_INDEX_DEFINITIONS,
  hirePhase5IndexPreparationModeOf,
  isExactHirePhase5Index,
  prepareHirePhase5Indexes,
} from "../prepare-hire-phase5-indexes";

const targetMocks = {
  "candidate-status-links": {
    createIndex: mocks.statusCreateIndex,
    indexes: mocks.statusIndexes,
    aggregate: mocks.statusAggregate,
    duplicateRows: mocks.statusDuplicateRows,
  },
  "report-exports": {
    createIndex: mocks.reportCreateIndex,
    indexes: mocks.reportIndexes,
    aggregate: mocks.reportAggregate,
    duplicateRows: mocks.reportDuplicateRows,
  },
  "report-export-cleanups": {
    createIndex: mocks.cleanupCreateIndex,
    indexes: mocks.cleanupIndexes,
    aggregate: mocks.cleanupAggregate,
    duplicateRows: mocks.cleanupDuplicateRows,
  },
  "digest-preferences": {
    createIndex: mocks.preferenceCreateIndex,
    indexes: mocks.preferenceIndexes,
    aggregate: mocks.preferenceAggregate,
    duplicateRows: mocks.preferenceDuplicateRows,
  },
  "digest-outboxes": {
    createIndex: mocks.outboxCreateIndex,
    indexes: mocks.outboxIndexes,
    aggregate: mocks.outboxAggregate,
    duplicateRows: mocks.outboxDuplicateRows,
  },
  "onboarding-test-drives": {
    createIndex: mocks.onboardingCreateIndex,
    indexes: mocks.onboardingIndexes,
    aggregate: mocks.onboardingAggregate,
    duplicateRows: mocks.onboardingDuplicateRows,
  },
} as const;

type Target = keyof typeof targetMocks;

function exactIndexes(target: Target) {
  return HIRE_PHASE5_INDEX_DEFINITIONS.filter(
    (definition) => definition.target === target,
  ).map((definition) => ({
    name: definition.name,
    key: definition.key,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.partialFilterExpression
      ? { partialFilterExpression: definition.partialFilterExpression }
      : {}),
  }));
}

function setAllExactIndexes(): void {
  for (const target of Object.keys(targetMocks) as Target[]) {
    targetMocks[target].indexes.mockResolvedValue(exactIndexes(target));
  }
}

function setAllMissingThenExact(): void {
  for (const target of Object.keys(targetMocks) as Target[]) {
    targetMocks[target].indexes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(exactIndexes(target));
  }
}

function resetCreateIndexResults(): void {
  for (const definition of HIRE_PHASE5_INDEX_DEFINITIONS) {
    targetMocks[definition.target].createIndex.mockResolvedValue(
      definition.name,
    );
  }
}

describe("Hire Phase 5 member-operations index preparation", () => {
  const originalSurface = process.env.IPG_SURFACE;
  const originalDatabase = process.env.HIRE_CONTROL_DATABASE_NAME;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.IPG_SURFACE = "hire-control";
    process.env.HIRE_CONTROL_DATABASE_NAME = "hire-control";
    mocks.connectDB.mockResolvedValue({ connection: { name: "hire-control" } });
    for (const target of Object.keys(targetMocks) as Target[]) {
      targetMocks[target].aggregate.mockReturnValue({
        toArray: targetMocks[target].duplicateRows,
      });
      targetMocks[target].duplicateRows.mockResolvedValue([]);
    }
    resetCreateIndexResults();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalSurface === undefined) delete process.env.IPG_SURFACE;
    else process.env.IPG_SURFACE = originalSurface;
    if (originalDatabase === undefined)
      delete process.env.HIRE_CONTROL_DATABASE_NAME;
    else process.env.HIRE_CONTROL_DATABASE_NAME = originalDatabase;
    vi.restoreAllMocks();
  });

  it("defaults to disconnected plan mode and rejects unsafe or ambiguous flags", async () => {
    expect(hirePhase5IndexPreparationModeOf([])).toBe("plan");
    expect(hirePhase5IndexPreparationModeOf(["--check"])).toBe("check");
    expect(hirePhase5IndexPreparationModeOf(["--apply"])).toBe("apply");
    expect(() =>
      hirePhase5IndexPreparationModeOf(["--apply", "--check"]),
    ).toThrow("mutually exclusive");
    expect(() => hirePhase5IndexPreparationModeOf(["--drop"])).toThrow(
      "unknown argument",
    );

    await prepareHirePhase5Indexes([]);

    expect(mocks.connectDB).not.toHaveBeenCalled();
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).not.toHaveBeenCalled();
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled();
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled();
    }
  });

  it("keeps --check read-only across every new Phase 5 model collection", async () => {
    setAllExactIndexes();

    await prepareHirePhase5Indexes(["--check"]);

    expect(mocks.connectDB).toHaveBeenCalledWith({
      schemaInitialization: "disabled",
    });
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].indexes).toHaveBeenCalledTimes(1);
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled();
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled();
    }
    expect(console.log).toHaveBeenCalledWith(
      `\nCHECK PASSED — all ${HIRE_PHASE5_INDEX_DEFINITIONS.length} exact Phase 5 Hire-control indexes exist.`,
    );
  });

  it("creates only missing exact indexes after every unique-data preflight", async () => {
    setAllMissingThenExact();

    await prepareHirePhase5Indexes(["--apply"]);

    expect(mocks.statusAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.reportAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.preferenceAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.outboxAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.onboardingAggregate).toHaveBeenCalledTimes(2);
    expect(mocks.statusCreateIndex).toHaveBeenCalledTimes(3);
    expect(mocks.reportCreateIndex).toHaveBeenCalledTimes(5);
    expect(mocks.cleanupCreateIndex).toHaveBeenCalledTimes(2);
    expect(mocks.preferenceCreateIndex).toHaveBeenCalledTimes(2);
    expect(mocks.outboxCreateIndex).toHaveBeenCalledTimes(3);
    expect(mocks.onboardingCreateIndex).toHaveBeenCalledTimes(7);
    expect(mocks.onboardingCreateIndex).toHaveBeenCalledWith(
      { workspaceId: 1, issuedByMemberId: 1, active: 1 },
      {
        name: "workspaceId_1_issuedByMemberId_1_active_1",
        unique: true,
        partialFilterExpression: { active: true },
      },
    );
    expect(console.log).toHaveBeenCalledWith(
      `\nAPPLY PASSED — all ${HIRE_PHASE5_INDEX_DEFINITIONS.length} exact indexes exist; no index was removed.`,
    );
  });

  it("fails closed on an incompatible same-key index before any preflight or write", async () => {
    setAllExactIndexes();
    mocks.statusIndexes.mockResolvedValue([
      ...exactIndexes("candidate-status-links").filter(
        (index) =>
          index.name !== "workspaceId_1_applicationId_1_issuanceOperationId_1",
      ),
      {
        name: "wrong-status-link-operation-index",
        key: { workspaceId: 1, applicationId: 1, issuanceOperationId: 1 },
        unique: false,
      },
    ]);

    await expect(prepareHirePhase5Indexes(["--apply"])).rejects.toThrow(
      "incompatible same-key Phase 5 index",
    );
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled();
      expect(targetMocks[target].aggregate).not.toHaveBeenCalled();
    }
  });

  it("fails closed before any write for duplicate active onboarding test drives", async () => {
    setAllMissingThenExact();
    mocks.onboardingDuplicateRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          _id: { workspaceId: "w", issuedByMemberId: "m", active: true },
          count: 2,
        },
      ]);

    await expect(prepareHirePhase5Indexes(["--apply"])).rejects.toThrow(
      "duplicate workspace/member active test-drive rows",
    );
    for (const target of Object.keys(targetMocks) as Target[]) {
      expect(targetMocks[target].createIndex).not.toHaveBeenCalled();
    }
  });

  it("requires the partial unique option, not merely the onboarding key pattern", () => {
    const definition = HIRE_PHASE5_INDEX_DEFINITIONS.find(
      (item) =>
        item.target === "onboarding-test-drives" &&
        item.name === "workspaceId_1_issuedByMemberId_1_active_1",
    );
    expect(definition).toBeDefined();
    expect(
      isExactHirePhase5Index(
        {
          name: definition!.name,
          key: definition!.key,
          unique: true,
        },
        definition!,
      ),
    ).toBe(false);
  });

  it("plans exactly the 22 schema-declared Phase 5 indexes and no operations guess", () => {
    expect(HIRE_PHASE5_INDEX_DEFINITIONS).toHaveLength(22);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "candidate-status-links",
      ),
    ).toHaveLength(3);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "report-exports",
      ),
    ).toHaveLength(5);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "report-export-cleanups",
      ),
    ).toHaveLength(2);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "digest-preferences",
      ),
    ).toHaveLength(2);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "digest-outboxes",
      ),
    ).toHaveLength(3);
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.filter(
        (definition) => definition.target === "onboarding-test-drives",
      ),
    ).toHaveLength(7);
    expect(HIRE_PHASE5_INDEX_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        target: "onboarding-test-drives",
        key: { workspaceId: 1, issuedByMemberId: 1, active: 1 },
        unique: true,
        partialFilterExpression: { active: true },
      }),
    );
    expect(
      HIRE_PHASE5_INDEX_DEFINITIONS.some((definition) =>
        definition.target.includes("operations"),
      ),
    ).toBe(false);
  });
});
