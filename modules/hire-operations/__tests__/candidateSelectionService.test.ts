import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  writeTransaction: vi.fn(),
  resolveExplicit: vi.fn(),
  resolveMatching: vi.fn(),
  create: vi.fn(),
  findOne: vi.fn(),
  deleteOne: vi.fn(),
  findExpired: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("../services/hireOperationsBoundary", () => ({
  connectHireOperationsDB: mocks.connectDB,
  withActiveHireWorkspaceWriteTransaction: mocks.writeTransaction,
}));

vi.mock("../services/candidateListService", () => ({
  resolveExplicitHireJobCandidateEntries: mocks.resolveExplicit,
  resolveHireJobCandidateQueryEntries: mocks.resolveMatching,
}));

vi.mock("../models/HireCandidateSelectionSnapshot", () => ({
  HireCandidateSelectionSnapshot: {
    create: mocks.create,
    findOne: mocks.findOne,
    deleteOne: mocks.deleteOne,
    find: mocks.findExpired,
    deleteMany: mocks.deleteMany,
  },
}));

import {
  HIRE_CANDIDATE_SELECTION_TTL_MS,
  createCandidateSelectionSnapshot,
  purgeExpiredCandidateSelectionSnapshots,
  readCandidateSelectionSnapshot,
} from "../services/candidateSelectionService";

const WORKSPACE_ID = "111111111111111111111111";
const JOB_ID = "222222222222222222222222";
const MEMBER_ID = "333333333333333333333333";
const APPLICATION_ID = "444444444444444444444444";
const SELECTION_ID = "555555555555555555555555";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const SESSION = { id: "selection-transaction" };
const ctx = {
  workspace: { _id: WORKSPACE_ID },
  membership: { _id: MEMBER_ID },
} as never;

function queryResult(value: unknown) {
  const query: any = {
    session: vi.fn(() => query),
    lean: vi.fn().mockResolvedValue(value),
  };
  return query;
}

describe("candidate selection snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.writeTransaction.mockImplementation(
      async (_workspaceId, _memberId, work) => work(SESSION),
    );
    mocks.resolveExplicit.mockResolvedValue([
      { applicationId: APPLICATION_ID, expectedStage: "new" },
    ]);
    mocks.resolveMatching.mockResolvedValue([
      { applicationId: APPLICATION_ID, expectedStage: "shortlist" },
    ]);
    mocks.create.mockImplementation(async ([value]) => [
      {
        ...value,
        _id: { toString: () => SELECTION_ID },
      },
    ]);
  });

  it("resolves explicit IDs server-side and persists immutable expected stages", async () => {
    const result = await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: { mode: "explicit", applicationIds: [APPLICATION_ID] },
      now: NOW,
    });

    expect(mocks.resolveExplicit).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      applicationIds: [APPLICATION_ID],
      now: NOW,
      session: SESSION,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          mode: "explicit",
          count: 1,
          entries: [
            expect.objectContaining({
              applicationId: expect.anything(),
              expectedStage: "new",
            }),
          ],
        }),
      ],
      { session: SESSION },
    );
    expect(result).toEqual({
      selectionId: SELECTION_ID,
      count: 1,
      expiresAt: "2026-08-25T12:15:00.000Z",
      description: "Selected candidates · 1 candidate",
      homogeneousStage: "new",
    });
  });

  it("resolves and persists inside the same active-workspace transaction", async () => {
    await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: { mode: "explicit", applicationIds: [APPLICATION_ID] },
      now: NOW,
    });

    expect(mocks.writeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) }),
      expect.any(Function),
    );
    expect(mocks.resolveExplicit.mock.calls[0][0].session).toBe(SESSION);
    expect(mocks.create.mock.calls[0][1].session).toBe(SESSION);
  });

  it("does not persist when the serialized privacy-safe resolver becomes empty", async () => {
    mocks.resolveExplicit.mockResolvedValueOnce([]);
    await expect(createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: { mode: "explicit", applicationIds: [APPLICATION_ID] },
      now: NOW,
    })).rejects.toMatchObject({ code: "CANDIDATE_SELECTION_EMPTY" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stores no search-derived digest and only a non-PII description for all-matching search", async () => {
    mocks.create.mockImplementation(async ([value]) => [
      {
        _id: { toString: () => SELECTION_ID },
        count: value.count,
        entries: value.entries,
        expiresAt: value.expiresAt,
        description: value.description,
      },
    ]);
    const result = await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: {
        mode: "all_matching",
        query: {
          q: "private.person@example.com",
          view: "decision_ready",
          stage: ["shortlist"],
          source: [],
          scoreState: [],
          humanReview: [],
          aiInterview: [],
          sort: "rank",
          direction: "asc",
        },
      },
      now: NOW,
    });

    const persisted = mocks.create.mock.calls[0][0][0];
    expect(persisted).not.toHaveProperty("queryFingerprint");
    expect(JSON.stringify(persisted)).not.toContain("private.person@example.com");
    expect(result.description).toBe(
      "All matching · 1 candidate · search applied · view=decision_ready · " +
      "stage=shortlist · source=all · jd_state=all · jd_range=any · human=all · " +
      "ai=all · history=any · applied=any · sort=rank:asc",
    );
    expect(result.description).not.toContain("private.person@example.com");
    expect(result.description.length).toBeLessThanOrEqual(500);
    expect(result.homogeneousStage).toBe("shortlist");
  });

  it("persists deterministic exact cohort codes while keeping search text redacted", async () => {
    const create = (stage: "new" | "offer", source: "apply_page" | "pool") =>
      createCandidateSelectionSnapshot(ctx, {
        jobId: JOB_ID,
        payload: {
          mode: "all_matching",
          query: {
            q: "sensitive@example.com",
            view: "all",
            stage: [stage], source: [source], scoreState: ["fresh"],
            scoreMin: 60, scoreMax: 90, humanReview: ["pending"],
            aiInterview: ["completed"], history: "returning",
            appliedFrom: "2026-08-01", appliedTo: "2026-08-25",
            sort: "newest", direction: "asc",
          },
        },
        now: NOW,
      });
    const first = await create("new", "apply_page");
    const second = await create("offer", "pool");

    expect(first.description).toContain("stage=new · source=apply_page");
    expect(second.description).toContain("stage=offer · source=pool");
    expect(first.description).not.toBe(second.description);
    expect(first.description).toContain("jd_state=fresh · jd_range=60..90");
    expect(first.description).toContain("sort=newest:desc");
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain("sensitive@example.com");
  });

  it("persists no search-derived field for canonically equivalent queries", async () => {
    const base = {
      view: "all" as const, stage: [], source: [], scoreState: [],
      humanReview: [], aiInterview: [], sort: "oldest" as const,
    };
    await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: { mode: "all_matching", query: { ...base, direction: "desc" } },
      now: NOW,
    });
    await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload: { mode: "all_matching", query: { ...base, direction: "asc" } },
      now: NOW,
    });
    expect(mocks.create.mock.calls[0][0][0]).not.toHaveProperty("queryFingerprint");
    expect(mocks.create.mock.calls[1][0][0]).not.toHaveProperty("queryFingerprint");
  });

  it.each([
    {
      label: "explicit",
      payload: {
        mode: "explicit" as const,
        applicationIds: [
          APPLICATION_ID,
          "666666666666666666666666",
        ],
      },
      resolver: "resolveExplicit" as const,
    },
    {
      label: "all matching",
      payload: {
        mode: "all_matching" as const,
        query: {
          view: "all" as const,
          stage: [],
          source: [],
          scoreState: [],
          humanReview: [],
          aiInterview: [],
          sort: "attention" as const,
          direction: "desc" as const,
        },
      },
      resolver: "resolveMatching" as const,
    },
  ])("derives a null stage from mixed $label immutable entries", async ({ payload, resolver }) => {
    mocks[resolver].mockResolvedValueOnce([
      { applicationId: APPLICATION_ID, expectedStage: "new" },
      {
        applicationId: "666666666666666666666666",
        expectedStage: "screened",
      },
    ]);

    const result = await createCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      payload,
      now: NOW,
    });

    expect(result.homogeneousStage).toBeNull();
  });

  it("reads authority with exact workspace/job/member scope and optional session", async () => {
    const session = { id: "transaction" } as never;
    const expiresAt = new Date(NOW.getTime() + 60_000);
    const query = queryResult({
      entries: [{ applicationId: { toString: () => APPLICATION_ID }, expectedStage: "offer" }],
      count: 1,
      description: "All matching · 1 candidate",
      expiresAt,
    });
    mocks.findOne.mockReturnValue(query);

    const result = await readCandidateSelectionSnapshot(ctx, {
      jobId: JOB_ID,
      selectionId: SELECTION_ID,
      now: NOW,
      session,
    });

    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: expect.anything(),
      workspaceId: expect.anything(),
      jobId: expect.anything(),
      memberId: expect.anything(),
    });
    expect(query.session).toHaveBeenCalledWith(session);
    expect(result).toMatchObject({
      selectionId: SELECTION_ID,
      jobId: JOB_ID,
      applicationIds: [APPLICATION_ID],
      entries: [{ applicationId: APPLICATION_ID, expectedStage: "offer" }],
      count: 1,
      homogeneousStage: "offer",
    });
  });

  it("fails closed when a snapshot is expired", async () => {
    mocks.findOne.mockReturnValue(
      queryResult({
        entries: [{ applicationId: APPLICATION_ID, expectedStage: "new" }],
        count: 1,
        description: "expired",
        expiresAt: new Date(NOW.getTime() - 1),
      }),
    );
    await expect(
      readCandidateSelectionSnapshot(ctx, {
        jobId: JOB_ID,
        selectionId: SELECTION_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_SELECTION_EXPIRED" });
  });

  it("purges a bounded expired batch without broad deletion", async () => {
    const expiredQuery: any = {
      sort: vi.fn(() => expiredQuery),
      limit: vi.fn(() => expiredQuery),
      select: vi.fn(() => expiredQuery),
      lean: vi.fn().mockResolvedValue([{ _id: APPLICATION_ID }]),
    };
    mocks.findExpired.mockReturnValue(expiredQuery);
    mocks.deleteMany.mockResolvedValue({ deletedCount: 1 });

    await expect(
      purgeExpiredCandidateSelectionSnapshots({ now: NOW, limit: 50 }),
    ).resolves.toBe(1);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      _id: { $in: [APPLICATION_ID] },
      expiresAt: { $lte: NOW },
    });
  });
});
