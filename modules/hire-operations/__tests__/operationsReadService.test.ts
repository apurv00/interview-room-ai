import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectHireControlDB: vi.fn(),
  testDriveExclusionStages: vi.fn(),
  jobAggregate: vi.fn(),
  candidateAggregate: vi.fn(),
  applicationAggregate: vi.fn(),
  humanRoundAggregate: vi.fn(),
  deliveryAggregate: vi.fn(),
  resultAggregate: vi.fn(),
  verdictAggregate: vi.fn(),
  analysisAggregate: vi.fn(),
  privacyRequestFind: vi.fn(),
  privacyFilter: vi.fn(),
  departmentFind: vi.fn(),
}));

vi.mock("@hire-operations-boundary", () => ({
  connectHireControlDB: mocks.connectHireControlDB,
  HIRE_HUMAN_KIT_MAX_ATTEMPTS: 3,
  HIRE_STAGES: [
    "new",
    "screened",
    "interviewing",
    "shortlist",
    "offer",
    "hired",
    "rejected",
    "withdrawn",
  ],
  HireJob: { aggregate: mocks.jobAggregate },
  HireCandidate: { aggregate: mocks.candidateAggregate },
  HireApplication: { aggregate: mocks.applicationAggregate },
  HireHumanRound: { aggregate: mocks.humanRoundAggregate },
  HireHumanKitDelivery: { aggregate: mocks.deliveryAggregate },
  HireInterviewResult: { aggregate: mocks.resultAggregate },
  HirePrivacyRequest: { find: mocks.privacyRequestFind },
  activeHirePrivacyRequestFilter: mocks.privacyFilter,
}));

vi.mock("@hire-decisions/models", () => ({
  HireExternalVerdict: { aggregate: mocks.verdictAggregate },
}));

vi.mock("@hire-departments/models", () => ({
  HireDepartment: { find: mocks.departmentFind },
}));

vi.mock("@/modules/hire-multimodal/models", () => ({
  HIRE_MULTIMODAL_ANALYSIS_MAX_RETRY_ATTEMPTS: 3,
  HireMultimodalAnalysis: { aggregate: mocks.analysisAggregate },
}));

vi.mock("@/modules/hire-onboarding/services/testDriveService", () => ({
  buildHireOnboardingTestDriveExclusionStages: mocks.testDriveExclusionStages,
}));

import {
  __hireOperations,
  readHireJobPerformance,
  readHireJobsHealth,
  readHireWorkspaceOverview,
} from "../services/operationsReadService";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const WORKSPACE_ID = "111111111111111111111111";

function query<T>(value: T) {
  const result = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  };
  result.select.mockReturnValue(result);
  return result;
}

function privacyRequestMatchesFilter(
  filter: Record<string, any>,
  request: { status: string; verificationExpiresAt: Date },
): boolean {
  if (filter.live !== true) return false;
  if (!Array.isArray(filter.$or)) return true;
  return filter.$or.some((condition: Record<string, any>) => {
    if (condition.status !== request.status) return false;
    if (!condition.verificationExpiresAt) return true;
    return request.verificationExpiresAt > condition.verificationExpiresAt.$gt;
  });
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    _id: "job-a",
    departmentId: "department-a",
    title: "Platform engineer",
    status: "open",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    ...overrides,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: "app-a",
    jobId: "job-a",
    candidateId: "candidate-a",
    stage: "new",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    events: [],
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    _id: "candidate-a",
    name: "Ada Lovelace",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    _id: "result-a",
    applicationId: "app-a",
    jobId: "job-a",
    candidateId: "candidate-a",
    completedAt: new Date("2026-08-02T00:00:00.000Z"),
    numericSummary: { overallScore: 80 },
    ...overrides,
  };
}

describe("Phase-5 operations read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectHireControlDB.mockResolvedValue(undefined);
    mocks.privacyRequestFind.mockReturnValue(query([]));
    mocks.departmentFind.mockReturnValue(
      query([{ _id: "department-a", name: "Engineering" }]),
    );
    mocks.privacyFilter.mockImplementation((now: Date) => ({
      live: true,
      $or: [
        { status: "processing" },
        { status: "pending_verification", verificationExpiresAt: { $gt: now } },
      ],
    }));
    mocks.testDriveExclusionStages.mockImplementation((input) => [
      {
        $lookup: {
          from: "hireonboardingtestdrives",
          as: `__testDrive_${input.coordinate}`,
        },
      },
      { $match: { [`__testDrive_${input.coordinate}.0`]: { $exists: false } } },
    ]);
    mocks.analysisAggregate.mockResolvedValue([]);
  });

  it("builds aggregate-only overview and attention-sorted health without candidate data", () => {
    const batch = {
      jobs: [
        job(),
        job({
          _id: "job-closed",
          title: "Closed role",
          status: "closed",
          createdAt: new Date("2026-08-01T12:00:00.000Z"),
          closedAt: new Date("2026-08-09T12:00:00.000Z"),
        }),
      ],
      applications: [
        application({
          stage: "shortlist",
          candidateName: "PRIVATE_CANDIDATE_NAME",
          events: [
            { to: "shortlist", at: new Date("2026-08-05T12:00:00.000Z") },
          ],
        }),
        application({ _id: "app-b", stage: "interviewing" }),
        application({ _id: "app-c", jobId: "job-closed", stage: "hired" }),
      ],
      humanRounds: [
        {
          jobId: "job-a",
          applicationId: "app-a",
          candidateId: "candidate-a",
          status: "pending_scorecard",
        },
        {
          jobId: "job-a",
          applicationId: "app-b",
          candidateId: "candidate-b",
          status: "completed",
        },
        {
          jobId: "job-a",
          applicationId: "app-b",
          candidateId: "candidate-b",
          status: "revoked",
        },
      ],
      terminalDeliveries: [
        { jobId: "job-a", applicationId: "app-a", candidateId: "candidate-a" },
      ],
      externalVerdicts: [
        { jobId: "job-a", applicationId: "app-a", candidateId: "candidate-a" },
      ],
      failedAnalyses: [
        { jobId: "job-a", applicationId: "app-a", candidateId: "candidate-a" },
      ],
    } as never;

    const overview = __hireOperations.buildWorkspaceOverview(batch, NOW);
    const health = __hireOperations.buildJobsHealth(batch, NOW);

    expect(overview).toMatchObject({
      asOf: NOW.toISOString(),
      kpis: {
        openJobs: 1,
        candidatesAwaitingDecision: 1,
        scorecardCompletion: { completed: 1, pending: 1, total: 2, rate: 0.5 },
        medianTimeToCloseDays: 8,
      },
      actionInbox: {
        items: [
          { kind: "candidates_awaiting_decision", count: 1 },
          { kind: "pending_human_scorecards", count: 1 },
          { kind: "terminal_human_kit_delivery_failures", count: 1 },
          { kind: "external_verdicts_received", count: 1 },
          { kind: "failed_multimodal_analyses", count: 1 },
        ],
      },
    });
    // Historical close-outs remain in the overview KPI, but never become
    // live Jobs-health rows.
    expect(health.jobs.map((item: { jobId: string }) => item.jobId)).toEqual([
      "job-a",
    ]);
    expect(health.jobs[0].attention).toEqual(
      expect.arrayContaining([
        {
          kind: "stuck_in_stage",
          stage: "shortlist",
          count: 1,
          oldestAgeDays: 9,
          thresholdDays: 6,
        },
        { kind: "candidates_awaiting_decision", count: 1 },
        { kind: "pending_human_scorecards", count: 1 },
        { kind: "failed_multimodal_analyses", count: 1 },
      ]),
    );
    expect(JSON.stringify({ overview, health })).not.toContain(
      "PRIVATE_CANDIDATE_NAME",
    );
    expect(JSON.stringify({ overview, health })).not.toContain("candidate-a");
  });

  it("returns only a same-job ranked fallback below 10 scores and uses the latest valid result per application", () => {
    const jobRecord = job({
      status: "closed",
      closedAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    const applications = [
      application({
        _id: "app-a",
        stage: "hired",
        events: [{ to: "hired", at: NOW }],
      }),
      application({
        _id: "app-b",
        candidateId: "candidate-b",
        stage: "offer",
        events: [{ to: "offer", at: NOW }],
      }),
      application({
        _id: "app-foreign",
        jobId: "job-foreign",
        candidateId: "candidate-foreign",
        stage: "hired",
      }),
    ];
    const smallSample = __hireOperations.buildJobPerformance({
      job: jobRecord,
      applications,
      candidates: [
        candidate(),
        candidate({ _id: "candidate-b", name: "Grace Hopper" }),
        candidate({
          _id: "candidate-foreign",
          name: "CROSS_JOB_CANDIDATE",
          email: "cross-job@example.com",
        }),
      ],
      humanRounds: [],
      results: [
        result({
          _id: "old",
          applicationId: "app-a",
          completedAt: new Date("2026-08-01T00:00:00.000Z"),
          numericSummary: { overallScore: 15 },
        }),
        result({
          _id: "new",
          applicationId: "app-a",
          completedAt: new Date("2026-08-02T00:00:00.000Z"),
          numericSummary: { overallScore: 95 },
        }),
        result({
          _id: "other",
          applicationId: "app-b",
          candidateId: "candidate-b",
          completedAt: new Date("2026-08-02T00:00:00.000Z"),
          numericSummary: { overallScore: 72 },
        }),
        result({
          _id: "cross-job",
          applicationId: "app-foreign",
          jobId: "job-foreign",
          candidateId: "candidate-foreign",
          numericSummary: { overallScore: 100 },
        }),
        result({
          _id: "mismatched-candidate",
          applicationId: "app-a",
          candidateId: "candidate-foreign",
          completedAt: new Date("2026-08-03T00:00:00.000Z"),
          numericSummary: { overallScore: 100 },
        }),
      ],
      now: NOW,
    } as never);

    expect(smallSample.scoreDistribution).toEqual({
      sampleSize: 2,
      chartEligible: false,
      buckets: [],
      fallbackCandidates: [
        {
          applicationId: "app-a",
          candidateName: "Ada Lovelace",
          score: 95,
          rank: 1,
        },
        {
          applicationId: "app-b",
          candidateName: "Grace Hopper",
          score: 72,
          rank: 2,
        },
      ],
    });
    expect(smallSample.funnel.conversions).toEqual(
      expect.arrayContaining([
        { stage: "offer", reached: 2, rateFromStart: 1 },
        { stage: "hired", reached: 1, rateFromStart: 0.5 },
      ]),
    );
    expect(smallSample.timeToCloseDays).toBe(10);
    expect(JSON.stringify(smallSample)).not.toContain("CROSS_JOB_CANDIDATE");
    expect(JSON.stringify(smallSample)).not.toContain("cross-job@example.com");
    expect(JSON.stringify(smallSample)).not.toContain("app-foreign");
  });

  it("emits a fixed histogram only at the 10-score floor and omits the fallback", () => {
    const scores = Array.from({ length: 10 }, (_, index) => index * 10);
    const distribution = __hireOperations.scoreDistribution(scores, [
      {
        applicationId: "app-a",
        candidateName: "Ada Lovelace",
        score: 90,
        rank: 1,
      },
    ]);
    expect(distribution).toEqual({
      sampleSize: 10,
      chartEligible: true,
      buckets: [
        { minimum: 0, maximum: 49, count: 5 },
        { minimum: 50, maximum: 59, count: 1 },
        { minimum: 60, maximum: 69, count: 1 },
        { minimum: 70, maximum: 79, count: 1 },
        { minimum: 80, maximum: 89, count: 1 },
        { minimum: 90, maximum: 100, count: 1 },
      ],
    });
    expect("fallbackCandidates" in distribution).toBe(false);
  });

  it("uses fixed workspace-scoped batch reads rather than one query per job or application", async () => {
    mocks.jobAggregate.mockResolvedValue([job({ _id: WORKSPACE_ID })]);
    mocks.candidateAggregate.mockResolvedValue([
      { _id: "222222222222222222222222" },
    ]);
    mocks.applicationAggregate.mockResolvedValue([
      application({ jobId: WORKSPACE_ID }),
    ]);
    mocks.humanRoundAggregate.mockResolvedValue([]);
    mocks.deliveryAggregate.mockResolvedValue([]);
    mocks.verdictAggregate.mockResolvedValue([]);

    await readHireWorkspaceOverview({ workspaceId: WORKSPACE_ID, now: NOW });

    expect(mocks.connectHireControlDB).toHaveBeenCalledTimes(1);
    expect(mocks.jobAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.candidateAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.applicationAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.humanRoundAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.verdictAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.analysisAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.privacyRequestFind).toHaveBeenCalledTimes(1);
    expect(mocks.departmentFind).toHaveBeenCalledTimes(1);
    const [applicationPipeline] = mocks.applicationAggregate.mock.calls[0];
    expect(applicationPipeline[0]).toMatchObject({
      $match: {
        workspaceId: expect.anything(),
        candidateId: { $in: ["222222222222222222222222"] },
      },
    });
    const [analysisPipeline] = mocks.analysisAggregate.mock.calls[0];
    expect(analysisPipeline[0]).toMatchObject({
      $match: {
        workspaceId: expect.anything(),
        candidateId: { $in: ["222222222222222222222222"] },
      },
    });
    expect(analysisPipeline).toEqual(expect.arrayContaining([
      {
        $group: {
          _id: { applicationId: "$applicationId", roundId: "$roundId" },
          latest: { $first: "$$ROOT" },
        },
      },
      {
        $match: expect.objectContaining({
          status: "failed",
          retryAttemptCount: { $gte: 3 },
        }),
      },
    ]));
  });

  it("returns a workspace-scoped Department label with each job tracking row", async () => {
    const DEPARTMENT_ID = "4".repeat(24);
    mocks.jobAggregate.mockResolvedValue([
      job({ departmentId: DEPARTMENT_ID }),
    ]);
    mocks.candidateAggregate.mockResolvedValue([]);
    mocks.departmentFind.mockReturnValue(
      query([{ _id: DEPARTMENT_ID, name: "Engineering" }]),
    );

    const health = await readHireJobsHealth({ workspaceId: WORKSPACE_ID, now: NOW });
    const performance = await readHireJobPerformance({
      workspaceId: WORKSPACE_ID,
      jobId: "2".repeat(24),
      now: NOW,
    });

    expect(health.jobs[0]?.department).toEqual({
      id: DEPARTMENT_ID,
      name: "Engineering",
    });
    expect(performance.job.department).toEqual({
      id: DEPARTMENT_ID,
      name: "Engineering",
    });
    expect(mocks.departmentFind).toHaveBeenNthCalledWith(1, {
      workspaceId: expect.anything(),
      _id: { $in: [DEPARTMENT_ID] },
    });
    expect(mocks.departmentFind).toHaveBeenNthCalledWith(2, {
      workspaceId: expect.anything(),
      _id: DEPARTMENT_ID,
    });
  });

  it("keeps expired verifications but fences processing privacy candidates out of overview, health, and small-n performance DTOs", async () => {
    const JOB_ID = "2".repeat(24);
    const SAFE_CANDIDATE_ID = "3".repeat(24);
    const PRIVACY_CANDIDATE_ID = "4".repeat(24);
    const SAFE_APPLICATION_ID = "5".repeat(24);
    const PRIVACY_APPLICATION_ID = "6".repeat(24);
    const PRIVATE_NAME = "LIVE_PRIVACY_CANDIDATE_NAME";
    const safeApplication = application({
      _id: SAFE_APPLICATION_ID,
      jobId: JOB_ID,
      candidateId: SAFE_CANDIDATE_ID,
      stage: "shortlist",
    });
    const privacyApplication = application({
      _id: PRIVACY_APPLICATION_ID,
      jobId: JOB_ID,
      candidateId: PRIVACY_CANDIDATE_ID,
      stage: "offer",
    });
    const candidateIdsInPipeline = (pipeline: Array<Record<string, unknown>>) =>
      (pipeline[0]?.$match as { candidateId?: { $in?: string[] } } | undefined)
        ?.candidateId?.$in ?? [];
    const scopedRows = <T>(
      pipeline: Array<Record<string, unknown>>,
      safe: T,
      privacy: T,
    ) =>
      candidateIdsInPipeline(pipeline).includes(PRIVACY_CANDIDATE_ID)
        ? [safe, privacy]
        : [safe];

    mocks.jobAggregate.mockResolvedValue([job({ _id: JOB_ID })]);
    mocks.candidateAggregate.mockImplementation(async (pipeline) => {
      const project = pipeline.at(-1)?.$project as
        { name?: unknown } | undefined;
      if (project?.name === 1) {
        const ids =
          (pipeline[0]?.$match as { _id?: { $in?: string[] } } | undefined)?._id
            ?.$in ?? [];
        return ids.includes(PRIVACY_CANDIDATE_ID)
          ? [
              { _id: SAFE_CANDIDATE_ID, name: "Ada Lovelace" },
              { _id: PRIVACY_CANDIDATE_ID, name: PRIVATE_NAME },
            ]
          : [{ _id: SAFE_CANDIDATE_ID, name: "Ada Lovelace" }];
      }
      return [{ _id: SAFE_CANDIDATE_ID }, { _id: PRIVACY_CANDIDATE_ID }];
    });
    const requests = [
      {
        candidateId: SAFE_CANDIDATE_ID,
        status: "pending_verification",
        verificationExpiresAt: new Date("2026-08-14T11:59:59.000Z"),
      },
      {
        candidateId: PRIVACY_CANDIDATE_ID,
        status: "processing",
        verificationExpiresAt: new Date("2026-08-14T12:10:00.000Z"),
      },
    ];
    mocks.privacyRequestFind.mockImplementation((filter: Record<string, any>) =>
      query(
        requests
          .filter((request) => privacyRequestMatchesFilter(filter, request))
          .map(({ candidateId }) => ({ candidateId })),
      ),
    );
    mocks.applicationAggregate.mockImplementation(async (pipeline) =>
      scopedRows(pipeline, safeApplication, privacyApplication),
    );
    mocks.humanRoundAggregate.mockResolvedValue([]);
    mocks.deliveryAggregate.mockImplementation(async (pipeline) =>
      scopedRows(
        pipeline,
        {
          jobId: JOB_ID,
          applicationId: SAFE_APPLICATION_ID,
          candidateId: SAFE_CANDIDATE_ID,
        },
        {
          jobId: JOB_ID,
          applicationId: PRIVACY_APPLICATION_ID,
          candidateId: PRIVACY_CANDIDATE_ID,
        },
      ),
    );
    mocks.verdictAggregate.mockResolvedValue([]);
    mocks.resultAggregate.mockImplementation(async (pipeline) =>
      scopedRows(
        pipeline,
        result({
          applicationId: SAFE_APPLICATION_ID,
          jobId: JOB_ID,
          candidateId: SAFE_CANDIDATE_ID,
          numericSummary: { overallScore: 82 },
        }),
        result({
          _id: "privacy-result",
          applicationId: PRIVACY_APPLICATION_ID,
          jobId: JOB_ID,
          candidateId: PRIVACY_CANDIDATE_ID,
          numericSummary: { overallScore: 98 },
        }),
      ),
    );

    const overview = await readHireWorkspaceOverview({
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const health = await readHireJobsHealth({
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const performance = await readHireJobPerformance({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      now: NOW,
    });

    expect(overview.kpis.candidatesAwaitingDecision).toBe(1);
    expect(health.jobs[0]?.funnel.shortlist).toBe(1);
    expect(health.jobs[0]?.funnel.offer).toBe(0);
    expect(performance.scoreDistribution).toEqual({
      sampleSize: 1,
      chartEligible: false,
      buckets: [],
      fallbackCandidates: [
        {
          applicationId: SAFE_APPLICATION_ID,
          candidateName: "Ada Lovelace",
          score: 82,
          rank: 1,
        },
      ],
    });

    const dtoJson = JSON.stringify({ overview, health, performance });
    expect(dtoJson).not.toContain(PRIVATE_NAME);
    expect(dtoJson).not.toContain(PRIVACY_CANDIDATE_ID);
    expect(dtoJson).not.toContain(PRIVACY_APPLICATION_ID);
    for (const [filter] of mocks.privacyRequestFind.mock.calls) {
      expect(filter).toEqual({
        workspaceId: expect.anything(),
        live: true,
        $or: [
          { status: "processing" },
          { status: "pending_verification", verificationExpiresAt: { $gt: NOW } },
        ],
      });
      expect(filter.workspaceId.toString()).toBe(WORKSPACE_ID);
    }
    expect(mocks.privacyFilter).toHaveBeenCalledWith(NOW);
    const performanceApplicationPipeline =
      mocks.applicationAggregate.mock.calls.at(-1)?.[0];
    expect(performanceApplicationPipeline[0].$match.candidateId).toEqual({
      $in: [SAFE_CANDIDATE_ID],
    });
  });

  it("excludes test-drive jobs and candidates before operations rows or a small-sample fallback", async () => {
    const NORMAL_JOB_ID = "2".repeat(24);
    const PRACTICE_JOB_ID = "3".repeat(24);
    const NORMAL_CANDIDATE_ID = "4".repeat(24);
    const PRACTICE_CANDIDATE_ID = "5".repeat(24);
    const NORMAL_APPLICATION_ID = "6".repeat(24);
    const PRACTICE_APPLICATION_ID = "7".repeat(24);
    const normalJob = job({ _id: NORMAL_JOB_ID });
    const practiceJob = job({
      _id: PRACTICE_JOB_ID,
      title: "Practice interview — Interview yourself",
    });
    const normalCandidate = candidate({
      _id: NORMAL_CANDIDATE_ID,
      name: "Ada Lovelace",
    });
    const practiceCandidate = candidate({
      _id: PRACTICE_CANDIDATE_ID,
      name: "Practice candidate — Interview yourself",
    });
    const hasTestDriveJoin = (pipeline: Array<Record<string, unknown>>) =>
      pipeline.some(
        (stage) =>
          (stage.$lookup as { from?: unknown } | undefined)?.from ===
          "hireonboardingtestdrives",
      );

    mocks.jobAggregate.mockImplementation(async (pipeline) => {
      const match = (pipeline[0] as { $match?: { _id?: unknown } }).$match;
      const requestsPracticeJob = match?._id?.toString() === PRACTICE_JOB_ID;
      if (requestsPracticeJob) {
        return hasTestDriveJoin(pipeline) ? [] : [practiceJob];
      }
      return hasTestDriveJoin(pipeline)
        ? [normalJob]
        : [normalJob, practiceJob];
    });
    mocks.candidateAggregate.mockImplementation(async (pipeline) => {
      return hasTestDriveJoin(pipeline)
        ? [normalCandidate]
        : [normalCandidate, practiceCandidate];
    });
    mocks.applicationAggregate.mockImplementation(async (pipeline) => {
      return hasTestDriveJoin(pipeline)
        ? [
            application({
              _id: NORMAL_APPLICATION_ID,
              jobId: NORMAL_JOB_ID,
              candidateId: NORMAL_CANDIDATE_ID,
            }),
          ]
        : [
            application({
              _id: NORMAL_APPLICATION_ID,
              jobId: NORMAL_JOB_ID,
              candidateId: NORMAL_CANDIDATE_ID,
            }),
            application({
              _id: PRACTICE_APPLICATION_ID,
              jobId: PRACTICE_JOB_ID,
              candidateId: PRACTICE_CANDIDATE_ID,
            }),
          ];
    });
    mocks.humanRoundAggregate.mockResolvedValue([]);
    mocks.deliveryAggregate.mockResolvedValue([]);
    mocks.verdictAggregate.mockResolvedValue([]);
    mocks.resultAggregate.mockResolvedValue([
      result({
        applicationId: NORMAL_APPLICATION_ID,
        jobId: NORMAL_JOB_ID,
        candidateId: NORMAL_CANDIDATE_ID,
      }),
    ]);

    const overview = await readHireWorkspaceOverview({
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const health = await readHireJobsHealth({
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const performance = await readHireJobPerformance({
      workspaceId: WORKSPACE_ID,
      jobId: NORMAL_JOB_ID,
      now: NOW,
    });

    expect(overview.kpis.openJobs).toBe(1);
    expect(health.jobs.map((item) => item.jobId)).toEqual([NORMAL_JOB_ID]);
    expect(performance.scoreDistribution).toMatchObject({
      fallbackCandidates: [
        {
          applicationId: NORMAL_APPLICATION_ID,
          candidateName: "Ada Lovelace",
        },
      ],
    });
    expect(JSON.stringify({ overview, health, performance })).not.toContain(
      "Practice interview",
    );
    expect(JSON.stringify({ overview, health, performance })).not.toContain(
      "Practice candidate",
    );
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "jobId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "candidateId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "applicationId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "roundId",
    });
    expect(mocks.testDriveExclusionStages).toHaveBeenCalledWith({
      coordinate: "applicationId",
      sourceIdField: "applicationId",
    });

    await expect(
      readHireJobPerformance({
        workspaceId: WORKSPACE_ID,
        jobId: PRACTICE_JOB_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "OPERATIONS_SCOPE_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("requires an exact workspace-owned job before calculating performance", async () => {
    mocks.jobAggregate.mockResolvedValue([]);
    mocks.candidateAggregate.mockResolvedValue([]);

    await expect(
      readHireJobPerformance({
        workspaceId: WORKSPACE_ID,
        jobId: "222222222222222222222222",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "OPERATIONS_SCOPE_NOT_FOUND",
      statusCode: 404,
    });
    const [jobPipeline] = mocks.jobAggregate.mock.calls[0];
    expect(jobPipeline[0]).toMatchObject({
      $match: {
        workspaceId: expect.anything(),
        _id: expect.anything(),
      },
    });
  });

  it("uses fixed job-scoped batches and selects display names only for that job's applications", async () => {
    const JOB_ID = "222222222222222222222222";
    const activeCandidates = [{ _id: "candidate-a" }, { _id: "candidate-b" }];
    const displayNames = [
      { _id: "candidate-a", name: "Ada Lovelace" },
      { _id: "candidate-b", name: "Grace Hopper" },
    ];
    mocks.jobAggregate.mockResolvedValue([job({ _id: JOB_ID })]);
    mocks.candidateAggregate
      .mockResolvedValueOnce(activeCandidates)
      .mockResolvedValueOnce(displayNames);
    mocks.applicationAggregate.mockResolvedValue([
      application({ _id: "app-a", jobId: JOB_ID }),
      application({
        _id: "app-b",
        jobId: JOB_ID,
        candidateId: "candidate-b",
      }),
    ]);
    mocks.humanRoundAggregate.mockResolvedValue([]);
    mocks.resultAggregate.mockResolvedValue([]);

    await readHireJobPerformance({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      now: NOW,
    });

    expect(mocks.jobAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.applicationAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.humanRoundAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.resultAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.candidateAggregate).toHaveBeenCalledTimes(2);
    expect(mocks.departmentFind).toHaveBeenCalledTimes(1);
    expect(mocks.departmentFind).toHaveBeenCalledWith({
      workspaceId: expect.anything(),
      _id: "department-a",
    });
    const [applicationPipeline] = mocks.applicationAggregate.mock.calls[0];
    expect(applicationPipeline[0]).toMatchObject({
      $match: {
        workspaceId: expect.anything(),
        jobId: expect.anything(),
        candidateId: { $in: ["candidate-a", "candidate-b"] },
      },
    });
    const [displayNamesPipeline] = mocks.candidateAggregate.mock.calls[1];
    expect(displayNamesPipeline[0]).toMatchObject({
      $match: {
        workspaceId: expect.anything(),
        _id: { $in: ["candidate-a", "candidate-b"] },
        piiAnonymizedAt: { $exists: false },
      },
    });
  });
});
