import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  aggregate: vi.fn(),
  exists: vi.fn(),
  jobFindOne: vi.fn(),
  workspaceFindOne: vi.fn(),
  departmentFindOne: vi.fn(),
  gateFindOne: vi.fn(),
  batchFindOne: vi.fn(),
  batchItemAggregate: vi.fn(),
  stages: [
    "new",
    "screened",
    "interviewing",
    "shortlist",
    "offer",
    "hired",
    "rejected",
    "withdrawn",
  ] as const,
}));

vi.mock("@hire-operations-boundary", () => ({
  HIRE_STAGES: mocks.stages,
  HireApplication: {
    collection: { name: "hireapplications" },
    aggregate: mocks.aggregate,
    exists: mocks.exists,
  },
  HireCandidate: { collection: { name: "hirecandidates" } },
  HireHumanRound: { collection: { name: "hirehumanrounds" } },
  HireHumanScorecard: { collection: { name: "hirehumanscorecards" } },
  HireIntakeTask: { collection: { name: "hireintaketasks" } },
  HireInvitationBatch: {
    collection: { name: "hireinvitationbatches" },
    findOne: mocks.batchFindOne,
  },
  HireInvitationBatchItem: {
    collection: { name: "hireinvitationbatchitems" },
    aggregate: mocks.batchItemAggregate,
  },
  HireJob: {
    collection: { name: "hirejobs" },
    findOne: mocks.jobFindOne,
  },
  HireWorkspace: { findOne: mocks.workspaceFindOne },
  HirePrivacyRequest: { collection: { name: "hireprivacyrequests" } },
  HireRound: { collection: { name: "hirerounds" } },
  HireScreeningGate: {
    collection: { name: "hirescreeninggates" },
    findOne: mocks.gateFindOne,
  },
}));

vi.mock("@hire-departments/models", () => ({
  HireDepartment: { findOne: mocks.departmentFindOne },
}));

vi.mock("@/modules/hire-onboarding/services/testDriveService", () => ({
  buildHireOnboardingTestDriveExclusionStages: () => [
    { $match: { "__hireOnboardingTestDrive.0": { $exists: false } } },
  ],
}));

vi.mock("../services/hireOperationsBoundary", () => ({
  connectHireOperationsDB: mocks.connectDB,
}));

import {
  HireJobCandidateReadError,
  readHireJobCandidateSummary,
  readHireJobCandidateIdentities,
  readHireJobCandidateFreshness,
  readHireJobCandidates,
  readHireJobOverview,
  resolveExplicitHireJobCandidateEntries,
  resolveHireJobCandidateQueryEntries,
} from "../services/candidateListService";
import type { HireJobCandidateQuery } from "../candidateTypes";

const WORKSPACE_ID = "111111111111111111111111";
const JOB_ID = "222222222222222222222222";
const APPLICATION_ID = "444444444444444444444444";
const NOW = new Date("2026-08-25T12:00:00.000Z");

function query(overrides: Partial<HireJobCandidateQuery> = {}): HireJobCandidateQuery {
  return {
    view: "all",
    stage: [],
    source: [],
    scoreState: [],
    humanReview: [],
    aiInterview: [],
    sort: "attention",
    direction: "desc",
    limit: 50,
    ...overrides,
  };
}

function chain<T>(value: T) {
  const result: any = {
    select: vi.fn(() => result),
    sort: vi.fn(() => result),
    limit: vi.fn(() => result),
    session: vi.fn(() => result),
    lean: vi.fn().mockResolvedValue(value),
  };
  return result;
}

function aggregateResult(value: unknown) {
  const aggregate: any = {
    option: vi.fn(() => aggregate),
    allowDiskUse: vi.fn().mockResolvedValue(value),
  };
  return aggregate;
}

function optionResult(value: unknown) {
  return { option: vi.fn().mockResolvedValue(value) };
}

function rawRow(index: number, rank = index + 451) {
  const id = (index + 10).toString(16).padStart(24, "0");
  return {
    _id: id,
    applicationId: id,
    candidate: {
      id: (index + 2_000).toString(16).padStart(24, "0"),
      name: `Candidate ${index}`,
      email: `candidate${index}@example.com`,
    },
    stage: "new",
    source: "apply_page",
    sourceHistory: ["apply_page"],
    appliedAt: new Date(NOW.getTime() - index * 1_000),
    lastActivityAt: new Date(NOW.getTime() - index * 500),
    attention: [],
    jdMatch: {
      state: "fresh",
      score: 90 - index / 100,
      rank,
      denominator: 700,
      scoredAt: new Date("2026-08-20T00:00:00.000Z"),
    },
    humanReview: {
      state: "none",
      total: 0,
      submitted: 0,
      pending: 0,
      recommendations: { strongYes: 0, yes: 0, no: 0, strongNo: 0 },
      disagreement: false,
    },
    aiInterview: { state: "not_invited", overallScore: null, updatedAt: null },
    workspaceHistory: { previousApplications: 0 },
    _sortPrimary: 80 - index,
  };
}

function pageResult(rows: unknown[], total = 1_000) {
  return [
    {
      rows,
      total: [{ count: total }],
      matching: [{ count: total }],
      stages: [
        { _id: "new", count: 800 },
        { _id: "shortlist", count: 200 },
      ],
      jdMatch: [
        { _id: "fresh", count: 700 },
        { _id: "stale", count: 100 },
        { _id: "unscored", count: 150 },
        { _id: "pending", count: 50 },
      ],
      savedViews: [
        {
          all: total,
          scoring_attention: 300,
          screening_attention: 800,
          interview_attention: 0,
          decision_ready: 200,
          offers: 0,
        },
      ],
    },
  ];
}

describe("readHireJobCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXTAUTH_SECRET", "candidate-cursor-test-secret-123456");
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(null);
    mocks.jobFindOne.mockReturnValue(
      chain({
        _id: JOB_ID,
        departmentId: "333333333333333333333333",
        title: "Platform engineer",
        jdText: "Build reliable systems",
        status: "open",
        applyPageEnabled: true,
        candidateReadVersion: 7,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    );
    mocks.workspaceFindOne.mockReturnValue(chain({ privacyAggregateFenceVersion: 11 }));
    mocks.gateFindOne.mockReturnValue(chain(null));
    mocks.batchFindOne.mockReturnValue(chain(null));
    mocks.batchItemAggregate.mockReturnValue(optionResult([]));
  });

  it("keeps a 1,000-application fixture bounded to 50 rows and preserves global ranks", async () => {
    const fixture = Array.from({ length: 1_000 }, (_, index) => rawRow(index, index + 451));
    // Deliberately return the whole fixture: the service still bounds its DTO,
    // while the generated Mongo pipeline independently proves limit + 1.
    mocks.aggregate.mockReturnValue(aggregateResult(fixture));

    const page = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query(),
      now: NOW,
    });

    expect(page.rows).toHaveLength(50);
    expect(page.rows[0].jdMatch.rank).toBe(451);
    expect(page.rows[0].jdMatch.denominator).toBe(700);
    expect(page.rows[49].jdMatch.rank).toBe(500);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.pageInfo.nextCursor).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.createdAt).toEqual({ $lt: NOW });
    expect(pipeline[1].$project).toEqual(
      expect.objectContaining({
        _id: 1,
        workspaceId: 1,
        jobId: 1,
        candidateId: 1,
        stage: 1,
        "resumeMatch.score": 1,
      }),
    );
    expect(pipeline[1].$project).not.toHaveProperty("events");
    expect(pipeline[1].$project).not.toHaveProperty("applicantSubmissions");
    const serializedPipeline = JSON.stringify(pipeline);
    expect(serializedPipeline).toContain("$setWindowFields");
    expect(serializedPipeline).toContain('"sortBy":{"_jdScore":-1}');
    expect(serializedPipeline).toContain('"_partitionRank":{"$rank":{}}');
    expect(serializedPipeline).not.toContain("$documentNumber");
    expect(serializedPipeline).toContain("resumeMatch.stale");
    expect(serializedPipeline).toContain("resumeMatch.jdHash");
    expect(serializedPipeline).toContain("results.sessionCompletedAt");
    expect(serializedPipeline).toContain("_aiRound.activityAt");
    expect(serializedPipeline).not.toContain("_aiRound.updatedAt");
    expect(pipeline).toContainEqual({ $limit: 51 });
    expect(pipeline).toContainEqual({
      $sort: { _sortPrimary: -1, _id: -1 },
    });
    expect(serializedPipeline).not.toContain("$facet");
    const serialized = JSON.stringify(page);
    expect(page).not.toHaveProperty("counts");
    expect(page).not.toHaveProperty("rankContext");
    for (const forbidden of [
      "resumeText",
      "events",
      "evidence",
      "overallComment",
      "inviteToken",
      "providerMessageId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("provides a bounded identity-only decision search without scoring or assessment joins", async () => {
    mocks.aggregate.mockReturnValue(
      aggregateResult([
        {
          _id: APPLICATION_ID,
          applicationId: APPLICATION_ID,
          candidateName: "Ada Lovelace",
          candidateEmail: "ada@example.com",
          _sortPrimary: "ada lovelace",
        },
        {
          _id: "444444444444444444444445",
          applicationId: "444444444444444444444445",
          candidateName: "Alan Turing",
          candidateEmail: "alan@example.com",
          _sortPrimary: "alan turing",
        },
      ]),
    );

    const page = await readHireJobCandidateIdentities({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: { q: "ad", limit: 1 },
      nonTerminalOnly: true,
      now: NOW,
    });

    expect(page).toEqual({
      candidates: [{
        applicationId: APPLICATION_ID,
        candidateName: "Ada Lovelace",
        candidateEmail: "ada@example.com",
      }],
      pageInfo: { limit: 1, nextCursor: expect.any(String) },
    });
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.createdAt).toEqual({ $lt: NOW });
    expect(pipeline[0].$match.stage).toEqual({
      $nin: ["hired", "rejected", "withdrawn"],
    });
    expect(pipeline).toContainEqual({ $limit: 2 });
    expect(JSON.stringify(pipeline)).not.toMatch(
      /resumeMatch|hireintaketasks|hirehumanrounds|hirehumanscorecards|hirerounds|\$setWindowFields/,
    );
    expect(Object.keys(pipeline.at(-1).$project).sort()).toEqual([
      "_id",
      "_sortPrimary",
      "applicationId",
      "candidateEmail",
      "candidateName",
    ]);
  });

  it("enforces the identity-search query bounds inside the service", async () => {
    await expect(
      readHireJobCandidateIdentities({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        query: { q: "", limit: 21 },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "JOB_CANDIDATES_INVALID_SCOPE" });
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("binds identity cursors to the non-terminal screening scope", async () => {
    mocks.aggregate.mockReturnValue(
      aggregateResult([
        {
          _id: APPLICATION_ID,
          applicationId: APPLICATION_ID,
          candidateName: "Ada Lovelace",
          candidateEmail: "ada@example.com",
          _sortPrimary: "ada lovelace",
        },
        {
          _id: "444444444444444444444445",
          applicationId: "444444444444444444444445",
          candidateName: "Alan Turing",
          candidateEmail: "alan@example.com",
          _sortPrimary: "alan turing",
        },
      ]),
    );
    const first = await readHireJobCandidateIdentities({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: { q: "ad", limit: 1 },
      nonTerminalOnly: true,
      now: NOW,
    });

    await expect(
      readHireJobCandidateIdentities({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        query: { q: "ad", limit: 1, cursor: first.pageInfo.nextCursor! },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "JOB_CANDIDATES_INVALID_CURSOR" });
  });

  it("binds the opaque cursor to workspace, job, filters, sort, and limit", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({ limit: 1 }),
      now: NOW,
    });
    const cursor = first.pageInfo.nextCursor!;

    await expect(
      readHireJobCandidates({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        query: query({ limit: 1, q: "different", cursor }),
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toMatchObject<HireJobCandidateReadError>({
      code: "JOB_CANDIDATES_INVALID_CURSOR",
    });
    await expect(
      readHireJobCandidates({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        query: query({ limit: 1, cursor: `${cursor.slice(0, -1)}x` }),
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({ code: "JOB_CANDIDATES_INVALID_CURSOR" });
  });

  it("rejects a subsequent page when the semantic candidate-read revision changes", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    mocks.jobFindOne.mockReturnValue(chain({
      _id: JOB_ID, departmentId: "333333333333333333333333",
      title: "Platform engineer", jdText: "Build reliable systems", status: "open",
      applyPageEnabled: true, candidateReadVersion: 8,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }));
    const aggregateCalls = mocks.aggregate.mock.calls.length;

    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "JOB_CANDIDATES_CURSOR_STALE", statusCode: 409 });
    expect(mocks.aggregate).toHaveBeenCalledTimes(aggregateCalls);
  });

  it("keeps frozen traversal when only the intake/new-arrival revision changes", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    mocks.jobFindOne.mockReturnValue(chain({
      _id: JOB_ID, departmentId: "333333333333333333333333",
      title: "Platform engineer", jdText: "Build reliable systems", status: "open",
      applyPageEnabled: true, candidateReadVersion: 7, intakeWriteVersion: 900,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }));

    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toMatchObject({ pageInfo: { snapshotAt: NOW.toISOString() } });
  });

  it("rejects a subsequent page after a candidate-directory mutation", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    mocks.workspaceFindOne.mockReturnValue(chain({ privacyAggregateFenceVersion: 12 }));

    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "JOB_CANDIDATES_CURSOR_STALE", statusCode: 409 });
  });

  it("does not stale for an unrelated workspace write-fence increment", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    mocks.workspaceFindOne.mockReturnValue(chain({
      privacyAggregateFenceVersion: 11, writeFenceVersion: 50,
    }));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    mocks.workspaceFindOne.mockReturnValue(chain({
      privacyAggregateFenceVersion: 11, writeFenceVersion: 99,
    }));

    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toMatchObject({ pageInfo: { snapshotAt: NOW.toISOString() } });
  });

  it("rejects when a mutation commits between the cursor precheck and page aggregate", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    mocks.workspaceFindOne
      .mockReturnValueOnce(chain({ privacyAggregateFenceVersion: 11 }))
      .mockReturnValueOnce(chain({ privacyAggregateFenceVersion: 12 }));

    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "JOB_CANDIDATES_CURSOR_STALE", statusCode: 409 });
    expect(mocks.aggregate).toHaveBeenCalledTimes(2);
  });

  it("binds cursors to the canonical applied-date direction", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({ sort: "newest", direction: "asc", limit: 1 }),
      now: NOW,
    });
    await expect(readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({
        sort: "newest", direction: "desc", limit: 1,
        cursor: first.pageInfo.nextCursor!,
      }),
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toMatchObject({ pageInfo: { snapshotAt: NOW.toISOString() } });
    expect(mocks.aggregate.mock.calls[0][0]).toContainEqual({
      $sort: { _sortPrimary: -1, _id: -1 },
    });
  });

  it("checks post-render arrivals against privacy-safe normalized filters without returning rows", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([{ _id: APPLICATION_ID }]));
    const snapshotAt = new Date(NOW.getTime() - 60_000).toISOString();
    const freshness = await readHireJobCandidateFreshness({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: {
        snapshotAt,
        q: "candidate", view: "decision_ready", stage: ["shortlist"],
        source: ["apply_page"], scoreState: ["fresh"], scoreMin: 70, scoreMax: 95,
        humanReview: ["disagreement"], aiInterview: ["completed"], history: "returning",
        appliedFrom: "2026-08-01", appliedTo: "2026-08-25",
        sort: "newest", direction: "asc",
      },
      now: NOW,
    });

    expect(freshness).toEqual({ hasNewerResults: true, checkedAt: NOW.toISOString() });
    expect(freshness).not.toHaveProperty("rows");
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({
      workspaceId: expect.anything(), jobId: expect.anything(),
      createdAt: { $gte: new Date(snapshotAt), $lte: NOW },
    });
    expect(pipeline).toContainEqual({ $limit: 1 });
    const plan = JSON.stringify(pipeline);
    for (const value of [
      "_livePrivacyRequest", "__hireOnboardingTestDrive", "_candidate.name",
      "_candidate.email", "apply_page", "fresh", "_humanDisagreement", "completed",
      "_historyCount", "shortlist",
    ]) expect(plan).toContain(value);
    expect(pipeline.at(-1)).toEqual({ $project: { _id: 1 } });
  });

  it("rejects invalid or expired freshness timestamps before database work", async () => {
    const base = { ...query(), snapshotAt: "invalid" };
    await expect(readHireJobCandidateFreshness({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: base, now: NOW,
    })).rejects.toMatchObject({ code: "JOB_CANDIDATES_INVALID_SCOPE" });
    await expect(readHireJobCandidateFreshness({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: { ...base, snapshotAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() },
      now: NOW,
    })).rejects.toMatchObject({ code: "JOB_CANDIDATES_INVALID_SCOPE" });
    expect(mocks.jobFindOne).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("freezes cursor traversal without coupling page reads to freshness polling", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({ limit: 1 }),
      now: NOW,
    });
    mocks.aggregate.mockReturnValueOnce(aggregateResult([rawRow(1)]));
    const second = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }),
      now: new Date(NOW.getTime() + 30_000),
    });

    expect(second.pageInfo.snapshotAt).toBe(NOW.toISOString());
    expect(mocks.aggregate).toHaveBeenCalledTimes(2);
  });

  it("freezes pending-privacy expiry visibility at the cursor snapshot", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0), rawRow(1)]));
    const first = await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID, query: query({ limit: 1 }), now: NOW,
    });
    const later = new Date(NOW.getTime() + 30 * 60_000);
    await readHireJobCandidates({
      workspaceId: WORKSPACE_ID, jobId: JOB_ID,
      query: query({ limit: 1, cursor: first.pageInfo.nextCursor! }), now: later,
    });

    const secondPlan = JSON.stringify(mocks.aggregate.mock.calls[1][0]);
    expect(secondPlan).toContain(
      `"verificationExpiresAt":{"$gt":"${NOW.toISOString()}"}`,
    );
    expect(secondPlan).not.toContain(
      `"verificationExpiresAt":{"$gt":"${later.toISOString()}"}`,
    );
  });

  it("builds every saved-view predicate inside the same tenant/job/privacy pipeline", async () => {
    for (const view of [
      "all",
      "scoring_attention",
      "screening_attention",
      "interview_attention",
      "decision_ready",
      "offers",
    ] as const) {
      mocks.aggregate.mockReturnValueOnce(aggregateResult([]));
      await resolveHireJobCandidateQueryEntries({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        query: { ...query({ view }), limit: undefined } as never,
        max: 5_000,
        now: NOW,
      });
      const pipeline = mocks.aggregate.mock.calls.at(-1)?.[0];
      expect(pipeline[0].$match).toMatchObject({
        workspaceId: expect.anything(),
        jobId: expect.anything(),
      });
      expect(JSON.stringify(pipeline)).toContain("_livePrivacyRequest");
      if (view === "decision_ready") expect(JSON.stringify(pipeline)).toContain("shortlist");
      if (view === "offers") expect(JSON.stringify(pipeline)).toContain("offer");
    }
  });

  it("pushes every supported filter into the server-side privacy-safe projection", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult([rawRow(0)]));

    await readHireJobCandidates({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({
        q: "candidate@example.com",
        stage: ["new"],
        source: ["apply_page"],
        scoreState: ["fresh"],
        scoreMin: 70,
        scoreMax: 95,
        humanReview: ["disagreement"],
        aiInterview: ["completed"],
        history: "returning",
        appliedFrom: "2026-08-01",
        appliedTo: "2026-08-25",
      }),
      now: NOW,
    });

    const plan = JSON.stringify(mocks.aggregate.mock.calls[0][0]);
    for (const coordinate of [
      "_candidate.name",
      "_candidate.email",
      "_candidate.sourceHistory",
      "_jdState",
      "_jdScore",
      "_humanDisagreement",
      "_aiState",
      "_historyCount",
      "createdAt",
      "_livePrivacyRequest",
    ]) {
      expect(plan).toContain(coordinate);
    }
  });

  it("pushes explicit IDs into the tenant/job scan before bounded selection work", async () => {
    mocks.aggregate.mockReturnValue(
      aggregateResult([{ applicationId: APPLICATION_ID, stage: "new" }]),
    );

    const rows = await resolveExplicitHireJobCandidateEntries({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      applicationIds: [APPLICATION_ID],
      now: NOW,
    });

    expect(rows).toEqual([
      { applicationId: APPLICATION_ID, expectedStage: "new" },
    ]);
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({
      workspaceId: expect.anything(),
      jobId: expect.anything(),
      _id: { $in: [expect.anything()] },
    });
    const plan = JSON.stringify(pipeline);
    expect(plan).not.toContain("$setWindowFields");
    expect(plan).not.toContain("hirehumanrounds");
    expect(plan).not.toContain("_workspaceHistory");
  });

  it("builds overview counts without candidate rows or detail/evidence joins", async () => {
    mocks.aggregate
      .mockReturnValueOnce(aggregateResult(pageResult([], 1_000)))
      .mockReturnValueOnce(optionResult([]));
    mocks.departmentFindOne.mockReturnValue(
      chain({ _id: "333333333333333333333333", name: "Engineering" }),
    );

    const overview = await readHireJobOverview({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      now: NOW,
    });

    expect(overview.counts.total).toBe(1_000);
    expect(overview.job.department.name).toBe("Engineering");
    expect(overview.recentActivity).toEqual([]);
    const countsPipeline = mocks.aggregate.mock.calls[0][0];
    const countsPlan = JSON.stringify(countsPipeline);
    expect(countsPlan).not.toContain("$setWindowFields");
    expect(countsPlan).not.toContain("hirehumanrounds");
    expect(countsPlan).not.toContain("hirerounds");
    expect(countsPlan).not.toContain("_workspaceHistory");
    expect(countsPipeline[1].$project).not.toHaveProperty("events");
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("rows");
    expect(serialized).not.toContain("resumeText");
    expect(serialized).not.toContain("email");
  });

  it("returns filtered counts and global-rank context from a separate summary read", async () => {
    mocks.aggregate.mockReturnValue(aggregateResult(pageResult([], 1_000)));

    const summary = await readHireJobCandidateSummary({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      query: query({ view: "decision_ready" }),
      now: NOW,
    });

    expect(summary.counts.total).toBe(1_000);
    expect(summary.counts.matching).toBe(1_000);
    expect(summary.rankContext).toEqual({
      freshScoredTotal: 700,
      stale: 100,
      unscored: 150,
      pending: 50,
    });
    expect(summary).not.toHaveProperty("rows");
    expect(summary).not.toHaveProperty("pageInfo");
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).not.toContain("$setWindowFields");
    expect(JSON.stringify(pipeline)).not.toContain("hirehumanrounds");
    expect(pipeline.at(-1)).toHaveProperty("$facet");
  });
});
